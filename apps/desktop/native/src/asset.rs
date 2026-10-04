//! 资产的 IPC 编码、执行器选择与脱敏错误。

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::{Arc, OnceLock};
use uuid::Uuid;

use crate::error::Error;
use crate::paths;
use poietica_asset::{
    AssetIntakeError, AssetProtocolError, AssetProtocolRegistry, ImportedAsset, ImportedKind,
    MAX_ASSET_BYTES, Removal, import_bytes, import_files,
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

#[derive(Clone, Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AssetReadRequest {
    pub session_token: String,
    pub asset_token: String,
    /// 只要这一段字节；缺席即整份。
    ///
    /// 视频与音频的 seek 与缩略图都走 HTTP Range，而注册表里那份是整份 —— 不在这里切，
    /// 就得把整份（上限 32 MiB）base64 过两遍 IPC，只为拿开头 1 KiB（实测 4 MiB 资产
    /// 取 1 KiB 要 147 ms，取整份才 180 ms）。
    pub offset: Option<u64>,
    pub length: Option<u64>,
}

/// 一次读回的字节。
///
/// 图片在被投递之前**只在内存注册表里**（进门不落盘，发送时才搬进附件根），
/// 所以宿主按磁盘路径找不到它。字节因此经这里交给主进程，由它按协议应答
/// （见 apps/desktop/electron/asset-protocol.ts）。
#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AssetReadResult {
    pub content_type: String,
    /// 这一段自己的长度，不是整份的。
    pub byte_length: u32,
    /// 整份资产的长度：Range 应答要拿它拼 `content-range: bytes a-b/total`。
    pub total_length: u32,
    /// base64 原始字节，不带 `data:` 前缀；与 AssetUploadRequest 同一条线上形状的理由。
    pub base64: String,
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
        tracing::warn!("asset ingestion task failed: {cause}");
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
        tracing::warn!("asset ingestion task failed: {cause}");
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
    tracing::warn!("asset ingestion failed: {error}");
    match error {
        AssetIntakeError::Protocol(cause) => map_asset_error(cause),
        AssetIntakeError::Blob(cause) => {
            tracing::error!("an attachment could not be staged: {cause}");
            Error::Asset("an attachment could not be stored".into()).into()
        }
        AssetIntakeError::Read(_) => Error::NotFound("file could not be read".into()).into(),
    }
}

/// 把注册表里那一份字节交给宿主。
///
/// 存在的理由只有一个：图片进门时不落盘，而 poietica-asset:// 的应答端在主进程里，
/// 拿不到注册表。注册表按 (session, hash) 记账，取的是**单个资产**，不是整张表。
///
/// 注册表是**进程内**的，重启后一定空，而地址里的摘要就是附件的磁盘路径 —— 所以
/// 未命中时按摘要回读附件根。没有这一步，重启后每一条历史 <img> 都是 404；有了它，
/// 投递过的字节与浏览器缓存的地址都还作数（cache-control 是 immutable，地址不变）。
#[specta::specta]
pub async fn asset_read(request: AssetReadRequest) -> CommandResult<AssetReadResult> {
    let (content_type, bytes) =
        match shared_registry().deliver(&request.session_token, &request.asset_token) {
            Ok(delivered) => (delivered.content_type, delivered.bytes),
            Err(AssetProtocolError::NotFound) => {
                let bytes = read_attachment(&request.session_token, &request.asset_token)?;
                let content_type = poietica_asset::classify(&bytes).to_owned();
                (content_type, bytes)
            }
            Err(cause) => return Err(map_asset_error(cause)),
        };
    let total = bytes.len();
    let total_length =
        u32::try_from(total).map_err(|_| map_asset_error(AssetProtocolError::AssetTooLarge))?;

    /*
     * 切片在这里做，不把整份交上去：注册表那份是 Arc<Vec<u8>>，切它不复制字节，
     * 但**编码**只编码要的那一段 —— 那一步才是这条路上真正随大小线性增长的成本。
     */
    let span = poietica_asset::read_span(total, request.offset, request.length);
    /*
     * `read_span` 保证落在总长以内（它的单测钉的就是这件事），取不出来才是不该发生的
     * 事 —— 用 `get` 而不是下标：那条越界在 release 下是未定义行为。
     */
    let slice = bytes
        .get(span)
        .ok_or_else(|| map_asset_error(AssetProtocolError::Internal))?;
    let byte_length = u32::try_from(slice.len())
        .map_err(|_| map_asset_error(AssetProtocolError::AssetTooLarge))?;

    Ok(AssetReadResult {
        content_type,
        byte_length,
        total_length,
        base64: BASE64.encode(slice),
    })
}

/// 摘要 → 盘上的字节。注册表缺席时唯一的去处。
///
/// 摘要是内容寻址的键，`read_blob` 自己核对字节与摘要相符：这条兜底路也不接受一份
/// 对不上的文件。
///
/// 两个根按令牌分派，因为它们各有各的账：附件根的那一份归账本（删对话会回收），
/// 发布根的那一份归助手产物（不随任何一条对话消失）。
#[allow(
    clippy::rc_buffer,
    reason = "shares the allocation shape of the registry path it falls back from"
)]
fn read_attachment(session_token: &str, asset_token: &str) -> CommandResult<Arc<Vec<u8>>> {
    let root = if session_token == poietica_asset::PUBLISHED_TOKEN {
        paths::published_root()
    } else {
        paths::attachments_root()
    }
    .map_err(Problem::from)?;

    poietica_asset::blob::read_blob(&root, asset_token)
        .map(Arc::new)
        .map_err(|cause| match cause {
            /* 没投递过、或已被回收：与注册表缺席是同一件事，都按 404 回。 */
            poietica_asset::blob::BlobError::Io(_) => map_asset_error(AssetProtocolError::NotFound),
            other => Problem::from(Error::from(other)),
        })
}

#[specta::specta]
pub async fn asset_remove(request: AssetRemoveRequest) -> CommandResult<()> {
    match shared_registry().remove(&request.session_token, &request.asset_token) {
        /* 会话不在册由注册表报 NotFound，直接落进下面那一臂。 */
        Ok(Removal::Released) => Ok(()),
        /*
         * 通用文件不进内存注册表（在 tmp 暂存，启动对账清）：查无此项不是错误。
         * 记 warn 而不是 debug：这一支同样接得住拼错的图片令牌，静默会把真错误埋掉。
         */
        Ok(Removal::NotRegistered) => {
            tracing::warn!("asset {} is not held by the registry", request.asset_token);
            Ok(())
        }
        Err(cause) => Err(map_asset_error(cause)),
    }
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
