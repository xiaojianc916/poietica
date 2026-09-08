//! IPC encoding, executor selection and redacted asset errors.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{State, async_runtime};
use uuid::Uuid;

use crate::error::Error;
use poietica_asset::{
    AssetIntakeError, AssetProtocolError, AssetProtocolRegistry, FORMATS, ImportedAsset,
    MAX_ASSET_BYTES, import_bytes, import_files,
};
use poietica_problem::Problem;

type CommandResult<T> = Result<T, Problem>;

#[derive(Clone, Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AssetUploadRequest {
    pub session_token: String,
    /// base64 编码的原始字节，不带 `data:` 前缀。
    ///
    /// 不是 `Vec<u8>`。默认的 JSON IPC 下 `Vec<u8>` 在线上是一个 `number[]`
    /// —— 每个字节一个十进制数字加一个逗号，比 base64 还大出四五倍。原始
    /// 字节只有在整个 args 就是 ArrayBuffer/Uint8Array 时才走 raw body，
    /// 塞在对象的一格里必然退化（见 Tauri v2 的 InvokeArgs）。
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

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AssetUploadResult {
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
pub struct AssetSessionCloseRequest {
    pub session_token: String,
}

/// Opens an asset session and returns its opaque token.
///
/// # Errors
///
/// Returns an error when the registry refuses to open the session. The caller
/// receives the redacted IPC message, never native detail.
#[tauri::command]
#[specta::specta]
pub async fn asset_session_open(
    assets: State<'_, AssetProtocolRegistry>,
) -> CommandResult<AssetSessionResult> {
    let session_token = Uuid::now_v7().simple().to_string();

    assets
        .open_session(&session_token)
        .map_err(map_asset_error)?;

    Ok(AssetSessionResult { session_token })
}

#[tauri::command]
#[specta::specta]
pub async fn asset_upload(
    request: AssetUploadRequest,
    assets: State<'_, AssetProtocolRegistry>,
) -> CommandResult<AssetUploadResult> {
    let registry = assets.inner().clone();
    async_runtime::spawn_blocking(move || {
        // Reject excessive transport allocation before asking the codec to decode.
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

#[tauri::command]
#[specta::specta]
pub async fn asset_import(
    request: AssetImportRequest,
    assets: State<'_, AssetProtocolRegistry>,
) -> CommandResult<Vec<AssetUploadResult>> {
    let registry = assets.inner().clone();
    async_runtime::spawn_blocking(move || {
        import_files(&registry, &request.session_token, &request.paths)
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
        AssetIntakeError::Read(_) => Error::NotFound("file could not be read".into()).into(),
    }
}

/// 一种收得下的格式，交给渲染层的那一面。
///
/// 只有内容类型和扩展名。判据（那个函数指针）留在这一侧：渲染层不判文件头，
/// 它拿这张表只为了给系统对话框写过滤器。
#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AssetFormat {
    kind: String,
    pub content_type: String,
    pub extensions: Vec<String>,
}

/// 收得下的格式清单。系统文件对话框的过滤器按它来。
///
/// 这条命令存在的唯一理由，是扩展名那张表不该有第二份。一个进程只问一次
/// （native-bridge 的 gateways 那侧缓存住），代价是一次本机往返，换掉的是一个漏改不
/// 报错的静默失败。
#[tauri::command]
#[specta::specta]
#[must_use]
pub fn asset_formats() -> Vec<AssetFormat> {
    FORMATS
        .iter()
        .map(|format| AssetFormat {
            kind: format.kind.as_str().to_owned(),
            content_type: format.content_type.to_owned(),
            extensions: format
                .extensions
                .iter()
                .map(|extension| (*extension).to_owned())
                .collect(),
        })
        .collect()
}

/// Removes one asset from an open session.
///
/// # Errors
///
/// Returns an error when the registry rejects the request, and when the asset
/// is not present in that session.
#[tauri::command]
#[specta::specta]
pub async fn asset_remove(
    request: AssetRemoveRequest,
    assets: State<'_, AssetProtocolRegistry>,
) -> CommandResult<()> {
    let removed = assets
        .remove(&request.session_token, &request.asset_token)
        .map_err(map_asset_error)?;

    if !removed {
        return Err(Error::NotFound("asset does not exist in session".into()).into());
    }

    Ok(())
}

/// Closes an asset session and releases everything it still holds.
///
/// # Errors
///
/// Returns an error only when the registry itself fails. A session that is
/// already gone is a success, not a failure: document close may have released
/// it first, and no caller should have to tell the two apart.
#[tauri::command]
#[specta::specta]
pub async fn asset_session_close(
    request: AssetSessionCloseRequest,
    assets: State<'_, AssetProtocolRegistry>,
) -> CommandResult<()> {
    /*
     * Document close may already have released a restored asset session, so a
     * session that is not there is a success rather than a failure. The
     * returned flag distinguishes the two cases and no caller needs to.
     */
    assets
        .remove_session(&request.session_token)
        .map_err(map_asset_error)?;

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

    use super::*;
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

        /* 改名成 .png 的 SVG。扩展名骗得过，文件头骗不过 —— 字节落成
        text/plain，而不是扩展名声称的图片。 */
        assert_eq!(
            sniff(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"),
            Some("text/plain")
        );
        assert_eq!(sniff(b"plain text"), Some("text/plain"));
        assert_eq!(sniff(b""), None);
    }

    #[test]
    fn the_file_dialog_is_offered_exactly_what_the_sniffer_accepts() {
        /* 交给渲染层的那张表就是判据那张表，一行不多一行不少。此前这两者
        是两个语言里的两份文本，这条断言当时写不出来。 */
        assert_eq!(asset_formats().len(), FORMATS.len());

        for format in FORMATS {
            /* 没有扩展名的格式在对话框里选不中，等于没登记。 */
            assert!(
                !format.extensions.is_empty(),
                "{} has no extension for the file dialog",
                format.content_type
            );

            /* 判据认得自己。这条挡的是「表里加了一行，判据忘了接上」。 */
            assert!(
                sniff(b"").is_none(),
                "an empty payload must never sniff as {}",
                format.content_type
            );
        }
    }

    #[test]
    fn every_importable_format_is_also_deliverable() {
        /* 导入先过嗅探再过注册表的白名单；两道门对不上时，用户会看到一条
        不说真因的错误。 */
        for format in FORMATS {
            assert!(
                poietica_asset::is_deliverable_content_type(format.content_type),
                "{} can be imported but not delivered",
                format.content_type
            );
        }
    }

    #[test]
    fn asset_errors_do_not_expose_internal_details() {
        let problem = map_asset_error(AssetProtocolError::RegistryBudgetExceeded);

        /* 过边界的只有一个码：句子归前端文案表，现场一条都不外带。 */
        assert_eq!(problem.code, Code::AssetRejected);
        assert!(problem.details.is_empty());
    }
}
