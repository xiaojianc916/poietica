//! Native IPC boundary for document-session binary assets.
//!
//! The renderer provides bytes and MIME metadata. Native owns validation,
//! content hashing, opaque delivery identities and protocol registration.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;
use tauri::{State, async_runtime};
use uuid::Uuid;

use crate::asset_protocol::{AssetProtocolError, AssetProtocolRegistry, asset_protocol_url};
use crate::error::{Error, IpcError};

type CommandResult<T> = Result<T, IpcError>;

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

/// 剪贴板里的那一张图：解码、按文件头判类型、存进一条打开着的资产会话。
///
/// 这是渲染层唯一还能把字节交给原生的入口，而它只为剪贴板存在：截图是一团
/// 没有名字也没有路径的 blob，系统给不出路径，所以它走不了 asset_import。
/// 别的每一条进门的路（窗口拖放、系统文件对话框）交的都是路径，字节根本不
/// 进 webview。
///
/// 内容类型不再由调用方声明。此前它是请求里的一格，而资产协议是带 nosniff
/// 投递的：声明什么就照什么投，等于把 MIME 的决定权交给了渲染层，而渲染层
/// 的 `File.type` 来自扩展名。判据与 asset_import 共用同一个 sniff，两条路
/// 因此不可能分叉。
///
/// # Errors
///
/// Returns an error when the payload is not valid base64, when its bytes are
/// not one of the deliverable image formats, when the payload length exceeds
/// `u32`, when the registry rejects the asset, or when the asset protocol URL
/// cannot be built — in that last case the stored asset is rolled back before
/// the error is returned.
#[tauri::command]
#[specta::specta]
pub async fn asset_upload(
    request: AssetUploadRequest,
    assets: State<'_, AssetProtocolRegistry>,
) -> CommandResult<AssetUploadResult> {
    let AssetUploadRequest {
        session_token,
        base64,
    } = request;

    /*
     * A command body runs on the async runtime's worker threads. Decoding,
     * sniffing and hashing are all CPU-bound over up to MAX_ASSET_BYTES, so
     * doing them here occupied a worker that every other pending command was
     * queued behind, in a function that awaited nothing at all.
     *
     * The registry write stays on this thread because State cannot cross the
     * boundary, and it is a short lock, not a scan.
     */
    let (content_hash, content_type, bytes) = async_runtime::spawn_blocking(move || {
        let bytes = BASE64
            .decode(base64.as_bytes())
            .map_err(|_| Error::Validation("attachment is not valid base64".into()))?;

        let content_type = sniff(&bytes)
            .ok_or_else(|| Error::Validation("unsupported attachment format".into()))?;

        let content_hash = hex::encode(Sha256::digest(&bytes));

        Ok::<_, Error>((content_hash, content_type, bytes))
    })
    .await
    .map_err(|_| Error::Internal("asset hashing task failed".into()))??;

    let byte_length =
        u32::try_from(bytes.len()).map_err(|_| Error::Asset("asset length overflow".into()))?;

    let asset_token = content_hash.clone();

    assets
        .insert(
            &session_token,
            &asset_token,
            &content_hash,
            content_type,
            bytes,
        )
        .map_err(map_asset_error)?;

    let source = match asset_protocol_url(&session_token, &asset_token) {
        Ok(source) => source,
        Err(error) => {
            let _ = assets.remove(&session_token, &asset_token);

            return Err(map_asset_error(error));
        }
    };

    Ok(AssetUploadResult {
        asset_token,
        content_hash,
        source,
        byte_length,
        content_type: content_type.to_owned(),
    })
}

/// Stores files the operating system handed us, named by path.
///
/// 字节不过 IPC。拖放与文件对话框交出来的都是路径，读盘因此发生在这一侧 ——
/// 让渲染层先把文件读进 webview、编码、再送回来，是为一个不存在的前提付三份
/// 代价（一次读、一次编码、一次比原文大三分之一的传输）。
///
/// 内容类型也由这里判定，判据是文件头而不是渲染层报的 `File.type` —— 后者来自
/// 扩展名，把 .svg 改名成 .png 就能骗过去，而资产协议是带 nosniff 投递的。认不
/// 出来的一律拒绝，白名单之外的格式在这一步就停住，不会走到界面上再报错。
///
/// # Errors
///
/// Returns an error when a file cannot be read, when its bytes are not one of
/// the deliverable image formats, when the payload length exceeds `u32`, when
/// the registry rejects the asset, or when the asset protocol URL cannot be
/// built — in that last case the stored asset is rolled back first.
#[tauri::command]
#[specta::specta]
pub async fn asset_import(
    request: AssetImportRequest,
    assets: State<'_, AssetProtocolRegistry>,
) -> CommandResult<Vec<AssetUploadResult>> {
    let AssetImportRequest {
        session_token,
        paths,
    } = request;

    /*
     * 读盘与哈希都是阻塞的，整批一次搬到阻塞执行器上 —— 与 asset_upload 里
     * 那段说明同一个理由，不是第二套做法。注册表写入留在这条线程上：State
     * 过不了边界，而那是一把短锁，不是一次扫描。
     */
    let read = async_runtime::spawn_blocking(move || {
        paths
            .into_iter()
            .map(|path| {
                let bytes = std::fs::read(&path)
                    .map_err(|_| Error::NotFound("file could not be read".into()))?;

                let content_type = sniff(&bytes)
                    .ok_or_else(|| Error::Validation("unsupported attachment format".into()))?;

                let content_hash = hex::encode(Sha256::digest(&bytes));

                Ok((content_hash, content_type, bytes))
            })
            .collect::<Result<Vec<_>, Error>>()
    })
    .await
    .map_err(|_| Error::Internal("asset import task failed".into()))??;

    let mut imported = Vec::with_capacity(read.len());

    for (content_hash, content_type, bytes) in read {
        let byte_length =
            u32::try_from(bytes.len()).map_err(|_| Error::Asset("asset length overflow".into()))?;

        let asset_token = content_hash.clone();

        assets
            .insert(
                &session_token,
                &asset_token,
                &content_hash,
                content_type,
                bytes,
            )
            .map_err(map_asset_error)?;

        let source = match asset_protocol_url(&session_token, &asset_token) {
            Ok(source) => source,
            Err(error) => {
                let _ = assets.remove(&session_token, &asset_token);

                return Err(map_asset_error(error));
            }
        };

        imported.push(AssetUploadResult {
            asset_token,
            content_hash,
            source,
            byte_length,
            content_type: content_type.to_owned(),
        });
    }

    Ok(imported)
}

/// 一种收得下的格式。
///
/// 文件头、内容类型、扩展名长在一起，因为它们是同一条策略的三个面：拿什么判、
/// 投递时写在 Content-Type 上的那个字符串、系统对话框里能被选中的名字。
///
/// 最后一样此前住在 TypeScript 里（desktop-adapters 的 IMAGE_EXTENSIONS），靠
/// 一句注释和这里保持一致。漏改哪一侧都不会报错，只会安静地坏：多在对话框那
/// 侧，用户选得中却什么也不发生；多在这一侧，新格式等于没加。
struct Format {
    kind: AssetKind,
    content_type: &'static str,
    extensions: &'static [&'static str],
    matches: fn(&[u8]) -> bool,
}

fn is_png(bytes: &[u8]) -> bool {
    bytes.starts_with(b"\x89PNG\r\n\x1a\n")
}

fn is_jpeg(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xFF, 0xD8, 0xFF])
}

fn is_gif(bytes: &[u8]) -> bool {
    bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")
}

fn is_bmp(bytes: &[u8]) -> bool {
    bytes.starts_with(b"BM")
}

fn is_webp(bytes: &[u8]) -> bool {
    bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP".as_slice())
}

fn is_avif(bytes: &[u8]) -> bool {
    bytes.get(4..12) == Some(b"ftypavif".as_slice())
}

/// 一种可附件的东西：缩略图那一类，还是纯色磁贴那一类。
///
/// 渲染层据此选画法，系统对话框据此分组。这是这张表唯一的分类维度。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AssetKind {
    Image,
    Text,
}

impl AssetKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Text => "text",
        }
    }
}

/// 判定文本只看这么多字节。与 Kimi 的 FS_BINARY_SAMPLE_BYTES 同一个数。
const TEXT_SAMPLE_BYTES: usize = 4 * 1024;

/// 这段字节是文本吗：首 4 KiB 是合法 UTF-8 且不含 NUL。
///
/// UTF-8 合法性交给 std::str::from_utf8，不自己数字节。样本边界会把一个多字节
/// 字符切断，那不是「不是文本」—— Utf8Error::error_len() 为 None 正是「还没读完」，
/// 所以退到 valid_up_to() 再判一次。NUL 是二进制最稳的标志，Kimi 的
/// classifyTextSample 也以它作硬判据。
fn is_text(bytes: &[u8]) -> bool {
    /* 空文件什么都不是：没有内容就没有种类，与「认不出来就是不投递」同一条。 */
    if bytes.is_empty() {
        return false;
    }

    let sample = bytes.get(..TEXT_SAMPLE_BYTES).unwrap_or(bytes);

    if sample.contains(&0) {
        return false;
    }

    match std::str::from_utf8(sample) {
        Ok(_text) => true,
        Err(error) => error.error_len().is_none() && error.valid_up_to() > 0,
    }
}

/// 这个应用收得下的全部格式，按判定顺序排。魔数、内容类型、扩展名、种类只在
/// 这里出现一次；文本排在最后 —— 它的判据是「不像任何一种图」的兜底，而图的
/// 魔数各自唯一。加一种格式就是这里加一行，没有第二处要跟着改。白名单必须是
/// asset_protocol::ALLOWED 的子集：这里认得的每一种，注册表都得收得下，否则
/// insert 会拒，而那时错误说的就不是真正的原因了。
const FORMATS: &[Format] = &[
    Format {
        kind: AssetKind::Image,
        content_type: "image/png",
        extensions: &["png"],
        matches: is_png,
    },
    Format {
        kind: AssetKind::Image,
        content_type: "image/jpeg",
        extensions: &["jpg", "jpeg"],
        matches: is_jpeg,
    },
    Format {
        kind: AssetKind::Image,
        content_type: "image/gif",
        extensions: &["gif"],
        matches: is_gif,
    },
    Format {
        kind: AssetKind::Image,
        content_type: "image/bmp",
        extensions: &["bmp"],
        matches: is_bmp,
    },
    Format {
        kind: AssetKind::Image,
        content_type: "image/webp",
        extensions: &["webp"],
        matches: is_webp,
    },
    Format {
        kind: AssetKind::Image,
        content_type: "image/avif",
        extensions: &["avif"],
        matches: is_avif,
    },
    Format {
        kind: AssetKind::Text,
        content_type: "text/plain",
        extensions: &[
            "txt", "md", "markdown", "json", "jsonc", "yaml", "yml", "toml", "ini", "csv", "tsv",
            "ts", "tsx", "js", "jsx", "mjs", "cjs", "css", "scss", "html", "xml", "sql", "rs",
            "go", "py", "rb", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php",
            "lua", "sh", "bash", "zsh", "ps1", "diff", "patch", "log",
        ],
        matches: is_text,
    },
];

/// 认文件头，不认扩展名。认不出来就是不投递。
///
/// 只在 FORMATS 里查，所以它不可能交回一种没有登记过的类型 —— 这不靠约定，
/// 靠的是没有别的地方可返回。
fn sniff(bytes: &[u8]) -> Option<&'static str> {
    FORMATS
        .iter()
        .find(|format| (format.matches)(bytes))
        .map(|format| format.content_type)
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
/// （desktop-adapters 那侧缓存住），代价是一次本机往返，换掉的是一个漏改不
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

fn map_asset_error(error: AssetProtocolError) -> IpcError {
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
    fn asset_errors_do_not_expose_internal_details() {
        let ipc = map_asset_error(AssetProtocolError::RegistryBudgetExceeded);

        assert_eq!(ipc.message, "资源处理失败");
    }
}
