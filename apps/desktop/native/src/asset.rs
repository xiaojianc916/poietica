//! 资产的 IPC 编码、执行器选择与脱敏错误。

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::OnceLock;
use uuid::Uuid;

use crate::error::Error;
use crate::paths;
use poietica_asset::{
    AssetIntakeError, AssetProtocolError, AssetProtocolRegistry, ImportedAsset, ImportedKind,
    MAX_ASSET_BYTES, import_bytes, import_files,
};
use poietica_problem::Problem;

type CommandResult<T> = Result<T, Problem>;

#[derive(Clone, Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AssetUploadRequest {
    pub session_token: String,
    /// base64 原始字节，不带 `data:` 前缀；刻意不用 `Vec<u8>`：JSON 边界上它线上是 `number[]`，大四五倍。
    pub base64: String,
}

#[derive(Clone, Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AssetImportRequest {
    pub session_token: String,
    pub paths: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AssetSessionResult {
    pub session_token: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AssetKind {
    Image,
    File,
}

impl From<ImportedKind> for AssetKind {
    fn from(kind: ImportedKind) -> Self {
        match kind {
            ImportedKind::Image => Self::Image,
            ImportedKind::File => Self::File,
        }
    }
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AssetUploadResult {
    /// Image：进内存注册表、source 是预览地址；File：落盘暂存、source 为空。
    pub kind: AssetKind,
    pub asset_token: String,
    pub content_hash: String,
    pub source: String,
    pub byte_length: u32,
    pub content_type: String,
}

#[derive(Clone, Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AssetRemoveRequest {
    pub session_token: String,
    pub asset_token: String,
}

/// 图片注册表是进程级的：一张图从投递到被 agent 读取，跨很多条命令。
static REGISTRY: OnceLock<AssetProtocolRegistry> = OnceLock::new();

pub(crate) fn shared_registry() -> &'static AssetProtocolRegistry {
    REGISTRY.get_or_init(AssetProtocolRegistry::default)
}

/// 调用方只见脱敏后的 IPC 文案，永远拿不到原生细节。
#[specta::specta]
pub async fn asset_session_open() -> CommandResult<AssetSessionResult> {
    let session_token = Uuid::now_v7().simple().to_string();

    shared_registry()
        .open_session(&session_token)
        .map_err(map_asset_error)?;

    Ok(AssetSessionResult { session_token })
}

#[specta::specta]
pub async fn asset_upload(request: AssetUploadRequest) -> CommandResult<AssetUploadResult> {
    let registry = shared_registry().clone();
    tokio::task::spawn_blocking(move || {
        if request.base64.len() > MAX_ASSET_BYTES.div_ceil(3) * 4 {
            return Err(map_asset_error(AssetProtocolError::AssetTooLarge));
        }
        let bytes = BASE64.decode(request.base64.as_bytes()).map_err(|_| {
            Problem::from(Error::Validation("attachment is not valid base64".into()))
        })?;
        import_bytes(&registry, &request.session_token, bytes)
            .map(AssetUploadResult::from)
            .map_err(map_intake_error)
    })
    .await
    .map_err(|cause| {
        log::warn!("asset ingestion task failed: {cause}");
        Problem::from(Error::Internal("asset ingestion task failed".into()))
    })?
}

#[specta::specta]
pub async fn asset_import(request: AssetImportRequest) -> CommandResult<Vec<AssetUploadResult>> {
    let registry = shared_registry().clone();
    let staging = paths::composer_staging_root().map_err(Problem::from)?;
    tokio::task::spawn_blocking(move || {
        import_files(&registry, &request.session_token, &staging, &request.paths)
            .map(|items| items.into_iter().map(AssetUploadResult::from).collect())
            .map_err(map_intake_error)
    })
    .await
    .map_err(|cause| {
        log::warn!("asset ingestion task failed: {cause}");
        Problem::from(Error::Internal("asset ingestion task failed".into()))
    })?
}

impl From<ImportedAsset> for AssetUploadResult {
    fn from(asset: ImportedAsset) -> Self {
        Self {
            kind: asset.kind.into(),
            asset_token: asset.content_hash.clone(),
            content_hash: asset.content_hash,
            source: asset.source,
            byte_length: asset.byte_length,
            content_type: asset.content_type,
        }
    }
}

fn map_intake_error(error: AssetIntakeError) -> Problem {
    log::warn!("asset ingestion failed: {error}");
    match error {
        AssetIntakeError::Protocol(cause) => map_asset_error(cause),
        AssetIntakeError::Blob(cause) => {
            log::error!("an attachment could not be staged: {cause}");
            Error::Asset("an attachment could not be stored".into()).into()
        }
        AssetIntakeError::Read(_) => Error::NotFound("file could not be read".into()).into(),
    }
}

#[specta::specta]
pub async fn asset_remove(request: AssetRemoveRequest) -> CommandResult<()> {
    let removed = shared_registry()
        .remove(&request.session_token, &request.asset_token)
        .map_err(map_asset_error)?;

    // 通用文件不进内存注册表（在 tmp 暂存，启动对账清）：查无此项不是错误。
    // 记 warn 而不是 debug：这一支同样接得住拼错的图片令牌，静默会把真错误埋掉。
    if !removed {
        log::warn!("asset {} is not held by the registry", request.asset_token);
    }

    Ok(())
}

fn map_asset_error(error: AssetProtocolError) -> Problem {
    let error = match error {
        AssetProtocolError::InvalidToken
        | AssetProtocolError::InvalidContentHash
        | AssetProtocolError::UnsupportedContentType
        | AssetProtocolError::AssetTooLarge => Error::Validation("invalid asset request".into()),

        AssetProtocolError::NotFound => Error::NotFound("asset session or asset not found".into()),

        AssetProtocolError::RegistryBudgetExceeded
        | AssetProtocolError::DuplicateAsset
        | AssetProtocolError::ReferenceOverflow => {
            Error::Asset("asset registry rejected resource".into())
        }

        AssetProtocolError::Internal => Error::Internal("asset registry unavailable".into()),
    };

    error.into()
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        clippy::unwrap_used,
        clippy::panic,
        clippy::indexing_slicing,
        clippy::shadow_unrelated,
        reason = "tests operate on known-good fixtures; a broken assumption must fail the test loudly"
    )]

    use super::{AssetProtocolError, map_asset_error};
    use poietica_asset::sniff;
    use poietica_problem::Code;
    use sha2::{Digest, Sha256};

    #[test]
    fn content_hash_is_canonical_sha256() {
        let hash = hex::encode(Sha256::digest(b"asset"));

        assert_eq!(hash.len(), 64);
        assert!(
            hash.bytes()
                .all(|byte| { byte.is_ascii_digit() || matches!(byte, b'a'..=b'f') })
        );
    }

    #[test]
    fn content_type_comes_from_the_bytes_not_the_name() {
        assert_eq!(
            sniff(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"),
            Some("image/png")
        );
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(sniff(b"RIFF\x00\x00\x00\x00WEBPVP8 "), Some("image/webp"));

        assert_eq!(
            sniff(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"),
            Some("text/plain")
        );
        assert_eq!(sniff(b"plain text"), Some("text/plain"));
        assert_eq!(sniff(b""), None);
    }

    #[test]
    fn asset_errors_do_not_expose_internal_details() {
        let problem = map_asset_error(AssetProtocolError::RegistryBudgetExceeded);

        assert_eq!(problem.code, Code::AssetRejected);
        assert!(problem.details.is_empty());
    }
}
