//! 取 CPython 的那一版资产清单，并从里面选出唯一一条。
//!
//! 走 API 资产路（`GET <asset.url>` 带 `Accept: application/octet-stream`，302 到 CDN），
//! 不用 release 的浏览器下载地址：github.com:443 在这批机器上连不上，API 与其重定向通。
//! 取清单必须带 User-Agent，不带是 403。

use std::path::Path;
use std::time::Duration;

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::{PythonError, SUPPORTED};

/// 上游 release 的 tag 就是构建批次日（不是 omp 版本号）。
pub const RELEASE_TAG: &str = "20261001";
/// 解释器版本：生态兼容面最宽、上游仍在支持期；3.14 太新、3.15 还是 rc，不追最新。
pub const PYTHON_VERSION: &str = "3.12.15";
/// 平台后缀。freethreaded 与 rc 的资产名在这两段之外还各带一个记号，所以和上面的
/// 版本拼起来在清单里只会命中一条（`asset_name` 就是这么拼的）。
pub const PLATFORM: &str = "x86_64-pc-windows-msvc";
/// 本 crate 只选 install_only_stripped：它只去掉调试符号，解释器该有的运行时都在，
/// 体积还少一半，交付给终端用户正是要这一档。
pub const ARCHIVE: &str = "install_only_stripped.tar.gz";

/// 要下的那个资产名。tag 与版本各只写一遍，名字从这里拼出来。
#[must_use]
pub fn asset_name() -> String {
    format!("cpython-{PYTHON_VERSION}+{RELEASE_TAG}-{PLATFORM}-{ARCHIVE}")
}

/// 连上主机的时间上限：机器离线时快速失败，而不是把整个超时耗光。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// 清单正文约 1.61MB，下载整段约 22MB。上限按**实测最慢的那条链路**给：
/// 本机实测下载 22MB 用 301s（≈73KB/s），按这个速率光读清单正文就要 ~22s ——
/// 原先的 15s 会在慢网上把「读正文超时」伪装成 "error decoding response body"。
/// 下载给 10min，清单给 2min；都只是上限，不是预期耗时。
const MANIFEST_TIMEOUT: Duration = Duration::from_secs(120);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);

/// 上游 release 里的一条资产。`url` 是 API 资产地址，不是给人点的下载页。
#[derive(Clone, Debug, Deserialize)]
pub struct Asset {
    pub name: String,
    pub size: u64,
    pub digest: String,
    pub url: String,
}

#[derive(Debug, Deserialize)]
struct Release {
    assets: Vec<Asset>,
}

/// 取清单这一步的错误只在这里产生；下载与解包的失败归 `PythonError` 的安装类变体。
#[derive(Debug, thiserror::Error)]
pub enum ReleaseError {
    #[error("本机不支持内置 Python（仅 Windows）")]
    Unsupported,
    #[error("HTTP 请求失败：{0}")]
    Http(String),
    #[error("资产清单不是合法 JSON：{0}")]
    Decode(String),
    #[error("HTTP {status}：{url}")]
    Status { status: u16, url: String },
}

/// 从清单里选出唯一那条候选。
///
/// 判据是**名字逐字相等**，不是子串包含：`20261001` 那一批里含
/// `x86_64-pc-windows-msvc` 且以 `install_only_stripped.tar.gz` 结尾的有 9 条
/// （3.10/3.11/3.12/3.13/3.13-ft/3.14/3.14-ft/3.15rc/3.15rc-ft），子串判据必然不唯一。
pub fn select_asset(assets: &[Asset]) -> Result<&Asset, PythonError> {
    let wanted = asset_name();
    let mut matches = assets.iter().filter(|asset| asset.name == wanted);
    let found = matches.next();
    let count = matches.count() + usize::from(found.is_some());

    match (found, count) {
        (None, _) => Err(PythonError::AssetMissing {
            tag: RELEASE_TAG.to_owned(),
            asset: wanted,
        }),
        (Some(asset), 1) => Ok(asset),
        (Some(_), count) => Err(PythonError::AssetAmbiguous {
            tag: RELEASE_TAG.to_owned(),
            asset: wanted,
            count,
        }),
    }
}

/// `sha256:…` → 64 位小写十六进制；前缀不对、长度不对、夹了非十六进制字符都算不认。
pub fn parse_sha256(digest: &str) -> Result<String, PythonError> {
    let hex = digest
        .strip_prefix("sha256:")
        .unwrap_or_default()
        .to_lowercase();

    if hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Ok(hex);
    }

    Err(PythonError::DigestMismatch {
        asset: asset_name(),
        expected: "<64 位十六进制>".to_owned(),
        actual: digest.to_owned(),
    })
}

/// 找到要下的那一条。
pub async fn fetch_asset() -> Result<Asset, PythonError> {
    if !SUPPORTED {
        return Err(ReleaseError::Unsupported.into());
    }

    let url = release_url();
    let response = manifest_request()
        .send()
        .await
        .map_err(|error| ReleaseError::Http(error.to_string()))?;
    let status = response.status();

    if !status.is_success() {
        return Err(ReleaseError::Status {
            status: status.as_u16(),
            url,
        }
        .into());
    }

    let release = response
        .json::<Release>()
        .await
        .map_err(|error| ReleaseError::Decode(error.to_string()))?;

    select_asset(&release.assets).cloned()
}

/// 流式下载并按上游摘要校验：22MB 不攒进内存，中途出错只留一个不完整的文件给调用方删。
/// 先看 Content-Length 再看哈希 —— 被截断的响应更该报"少下了字节"，而不是报摘要不符。
pub async fn download(asset: &Asset, destination: &Path) -> Result<(), PythonError> {
    let failed = |reason: String| PythonError::Download {
        asset: asset.name.clone(),
        reason,
    };

    let response = client()
        .get(&asset.url)
        .header(reqwest::header::ACCEPT, "application/octet-stream")
        .send()
        .await
        .map_err(|error| failed(error.to_string()))?;
    let status = response.status();

    if !status.is_success() {
        return Err(failed(format!("HTTP {}", status.as_u16())));
    }

    // 上游先给 302 的 Content-Length，跟着跳到 CDN 之后才是字节数，所以取跳转后的。
    let declared = response.content_length().unwrap_or(asset.size);

    if declared != asset.size {
        return Err(PythonError::SizeMismatch {
            asset: asset.name.clone(),
            expected: asset.size,
            actual: declared,
        });
    }

    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    let mut response = response;
    let mut file = tokio::fs::File::create(destination).await?;
    let mut hasher = Sha256::new();
    let mut written = 0_u64;

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| failed(error.to_string()))?
    {
        hasher.update(&chunk);
        written += chunk.len() as u64;
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk).await?;
    }

    tokio::io::AsyncWriteExt::flush(&mut file).await?;

    if written != asset.size {
        return Err(PythonError::SizeMismatch {
            asset: asset.name.clone(),
            expected: asset.size,
            actual: written,
        });
    }

    let actual = to_hex(&hasher.finalize());
    let expected = parse_sha256(&asset.digest)?;

    if actual != expected {
        return Err(PythonError::DigestMismatch {
            asset: asset.name.clone(),
            expected,
            actual,
        });
    }

    Ok(())
}

/// 摘要按小写十六进制报出来，与上游 sha256: 后面的写法一致；只为转一次字符串不引 hex crate。
fn to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;

    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut text, byte| {
            let _ = write!(text, "{byte:02x}");
            text
        })
}

/// 全仓一份 HTTP 客户端形状：超时与 User-Agent（GitHub API 没有它直接 403）在这里定死。
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(DOWNLOAD_TIMEOUT)
        .user_agent(concat!("poietica/", env!("CARGO_PKG_VERSION")))
        .build()
        .unwrap_or_default()
}

/// 一个请求的超时；清单与下载共用同一份 builder，超时按调用点给。
///
/// **不要给这个请求加 `Accept: application/vnd.github+json`**：带上它 GitHub 会回压缩体，
/// 而这份 client 没开 gzip/brotli 解码（reqwest 的压缩是一个 feature），
/// 于是 `.json()` 报 "error decoding response body" —— 真网络才现形，喂内存 JSON 的单测看不见。
/// 不带那个 Accept 时响应是明文，实测 1,610,838 字节可直接解析。
fn manifest_request() -> reqwest::RequestBuilder {
    client().get(release_url()).timeout(MANIFEST_TIMEOUT)
}

/// API 资产地址：清单与字节都从这里走。
fn release_url() -> String {
    format!(
        "https://api.github.com/repos/astral-sh/python-build-standalone/releases/tags/{RELEASE_TAG}"
    )
}
