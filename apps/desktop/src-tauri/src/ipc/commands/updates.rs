//! 更新的原生一端：取清单、取载荷、校验、暂存、换装重启。
//!
//! 判据与编解码归 poietica-update-native；何时检查、怎么呈现归渲染层。
use crate::error::Error;
use poietica_problem::Problem;
use poietica_update_native as update;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;
use tauri::{AppHandle, Manager, command};
use tauri_specta::Event;
/// 命令面上的错误是 Problem：Error 的变体带着路径与系统串，经 error.rs 那张脱敏表
/// 过一遍之后才是契约。
type UpdateCommandResult<T> = Result<T, Problem>;
/// 客户端真正会去拉的那条地址。发布脚本读同一个文件，两边不可能各写各的。
const MANIFEST_URL: &str = include_str!("../../../updater/manifest.url");
/// 发布签名的公钥：minisign 公钥文件的 base64。
const RELEASE_KEY: &str = include_str!("../../../updater/public.key");
/// 只罩住清单往返。载荷是几十 MB，共用一个上限会把下载掉断。
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
/// 校验过、等着换装的那一个。
const STAGED_SUFFIX: &str = "staged";
/// 换装时被挠开的旧映像。本进程删不掉它，下一次启动扫。
const REPLACED_SUFFIX: &str = "outgoing";
/// 一个可安装的新版本，以及这一次会走哪条路。
#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRelease {
    pub version: String,
    pub notes: Option<String>,
    pub kind: UpdateKind,
}
/// 契约上的投影：判定归更新域，这里只负责说给渲染层听。
#[derive(Clone, Copy, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum UpdateKind {
    Patch,
    Full,
}
impl From<update::PayloadKind> for UpdateKind {
    fn from(kind: update::PayloadKind) -> Self {
        match kind {
            update::PayloadKind::Patch => Self::Patch,
            update::PayloadKind::Full => Self::Full,
        }
    }
}
/// 下载进度。percent 为 None 表示服务端没给长度。
#[derive(Clone, Copy, Debug, Deserialize, Event, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub percent: Option<u8>,
}
/// 暂存态归进程：由 bootstrap 创建、随进程结束。命令只借用。
#[derive(Default)]
pub struct UpdateStaging(Mutex<Staging>);
#[derive(Default)]
enum Staging {
    #[default]
    Empty,
    Downloading(String),
    Staged(Box<StagedUpdate>),
}
/// 落在磁盘上的那一份成品。不留在内存里：它就是一整个可执行文件。
struct StagedUpdate {
    version: String,
    path: PathBuf,
}
enum Begin {
    Start,
    Ready,
    Busy,
}
impl UpdateStaging {
    fn lock(&self) -> MutexGuard<'_, Staging> {
        /* 锁只护一个三态枚举，中毒也没有半个状态可言，取回来继续用。 */
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
    fn begin(&self, version: &str) -> Begin {
        let mut staging = self.lock();
        match &*staging {
            Staging::Staged(staged) if staged.version == version => Begin::Ready,
            Staging::Downloading(_pending) => Begin::Busy,
            _idle => {
                *staging = Staging::Downloading(version.to_owned());
                Begin::Start
            }
        }
    }
    fn finish(&self, staged: StagedUpdate) {
        *self.lock() = Staging::Staged(Box::new(staged));
    }
    fn abandon(&self, version: &str) {
        let mut staging = self.lock();
        if matches!(&*staging, Staging::Downloading(pending) if pending == version) {
            *staging = Staging::Empty;
        }
    }
    fn take(&self) -> Option<Box<StagedUpdate>> {
        let mut staging = self.lock();
        match std::mem::take(&mut *staging) {
            Staging::Staged(staged) => Some(staged),
            idle => {
                *staging = idle;
                None
            }
        }
    }
}
impl std::fmt::Debug for UpdateStaging {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &*self.lock() {
            Staging::Empty => formatter.write_str("UpdateStaging(empty)"),
            Staging::Downloading(version) => {
                write!(formatter, "UpdateStaging(downloading {version})")
            }
            Staging::Staged(staged) => {
                write!(formatter, "UpdateStaging(staged {})", staged.version)
            }
        }
    }
}
/// 下载提前结束时把暂存态放回去。谁开始的谁负责收尾。
struct DownloadGuard<'a> {
    staging: &'a UpdateStaging,
    version: String,
    armed: bool,
}
impl Drop for DownloadGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.staging.abandon(&self.version);
        }
    }
}
fn failure(reason: &str, cause: &dyn std::fmt::Display) -> Problem {
    log::warn!("update {reason}: {cause}");
    Error::Plugin("the update could not be completed".to_owned()).into()
}
/// 读文件、算哈希、解压、写盘全在阻塞池上做：异步执行器不该被几十 MB 卡住。
async fn blocking<T, F>(work: F) -> UpdateCommandResult<T>
where
    F: FnOnce() -> update::Result<T> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|dropped| failure("worker did not finish", &dropped))?
        .map_err(|cause| failure("local step failed", &cause))
}
fn running_binary() -> UpdateCommandResult<PathBuf> {
    std::env::current_exe().map_err(|cause| failure("the running binary is unlocatable", &cause))
}
/// 装着的那个可执行文件就是增量的基线。
async fn baseline() -> UpdateCommandResult<Vec<u8>> {
    blocking(|| Ok(std::fs::read(std::env::current_exe()?)?)).await
}
fn sidecar(binary: &Path, suffix: &str) -> PathBuf {
    let mut name = binary
        .file_name()
        .map_or_else(OsString::new, OsString::from);
    name.push(".");
    name.push(suffix);
    binary.with_file_name(name)
}
/// 百分比只有 101 个可见值，同一个不重复播报。
fn percent_of(downloaded: u64, total: Option<u64>) -> Option<u8> {
    let total = total?;
    if total == 0 {
        return None;
    }
    u8::try_from((downloaded.saturating_mul(100) / total).min(100)).ok()
}
async fn published_manifest() -> UpdateCommandResult<update::Manifest> {
    let response = tokio::time::timeout(CHECK_TIMEOUT, reqwest::get(MANIFEST_URL.trim()))
        .await
        .map_err(|elapsed| failure("check timed out", &elapsed))?
        .map_err(|cause| failure("the manifest is unreachable", &cause))?
        .error_for_status()
        .map_err(|cause| failure("the manifest request was refused", &cause))?;
    let body = response
        .bytes()
        .await
        .map_err(|cause| failure("the manifest download failed", &cause))?;
    update::Manifest::parse(&body).map_err(|cause| failure("the manifest is malformed", &cause))
}
/// 边下边报进度。不报重复百分比，事件数与文件大小无关。
async fn download_payload(app: &AppHandle, url: &str) -> UpdateCommandResult<Vec<u8>> {
    let mut response = reqwest::get(url)
        .await
        .map_err(|cause| failure("the payload is unreachable", &cause))?
        .error_for_status()
        .map_err(|cause| failure("the payload request was refused", &cause))?;
    let total = response.content_length();
    let mut payload = Vec::with_capacity(
        total
            .and_then(|length| usize::try_from(length).ok())
            .unwrap_or_default(),
    );
    let mut received: u64 = 0;
    let mut broadcast: Option<u8> = None;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|cause| failure("the payload download failed", &cause))?
    {
        received = received.saturating_add(chunk.len() as u64);
        payload.extend_from_slice(&chunk);
        let percent = percent_of(received, total);
        if percent != broadcast {
            broadcast = percent;
            if let Err(error) = (UpdateProgress { percent }).emit(app) {
                log::warn!("could not report update progress: {error}");
            }
        }
    }
    Ok(payload)
}
#[command]
#[specta::specta]
pub async fn update_check(app: AppHandle) -> UpdateCommandResult<Option<UpdateRelease>> {
    let manifest = published_manifest().await?;
    if !manifest.supersedes(&app.package_info().version.to_string()) {
        return Ok(None);
    }
    let installed = baseline().await?;
    let selection = manifest.select(&update::hash(&installed));
    Ok(Some(UpdateRelease {
        version: manifest.version.clone(),
        notes: manifest.notes.clone(),
        kind: selection.kind.into(),
    }))
}
#[command]
#[specta::specta]
pub async fn update_download(app: AppHandle, version: String) -> UpdateCommandResult<()> {
    let staging = app.state::<UpdateStaging>();
    match staging.begin(&version) {
        Begin::Ready => return Ok(()),
        Begin::Busy => {
            return Err(
                Error::Validation("an update download is already in flight".to_owned()).into(),
            );
        }
        Begin::Start => {}
    }
    let mut guard = DownloadGuard {
        staging: &staging,
        version: version.clone(),
        armed: true,
    };
    let manifest = published_manifest().await?;
    if manifest.version != version {
        return Err(Error::NotFound(format!("release {version} is no longer published")).into());
    }
    let installed = baseline().await?;
    let selection = manifest.select(&update::hash(&installed));
    let kind = selection.kind;
    let signature = selection.signature.to_owned();
    let url = selection.url.to_owned();
    let expected = manifest.payload_hash.clone();
    let payload = download_payload(&app, &url).await?;
    let staged = sidecar(&running_binary()?, STAGED_SUFFIX);
    let destination = staged.clone();
    /* 签名 → 解码 → 哈希 → 落盘，一条路。任何一步不过就不会有文件落到磁盘上。 */
    blocking(move || {
        update::verify(RELEASE_KEY, &signature, &payload)?;
        let binary = update::decode(kind, &installed, &payload)?;
        if update::hash(&binary) != expected {
            return Err(update::UpdateError::Hash);
        }
        Ok(std::fs::write(destination, binary)?)
    })
    .await?;
    staging.finish(StagedUpdate {
        version,
        path: staged,
    });
    guard.armed = false;
    Ok(())
}
#[command]
#[specta::specta]
pub async fn update_relaunch(app: AppHandle) -> UpdateCommandResult<()> {
    let Some(staged) = app.state::<UpdateStaging>().take() else {
        return Err(Error::NotFound("no downloaded update is waiting".to_owned()).into());
    };
    blocking(move || swap(&staged.path)).await?;
    crate::shutdown::relaunch(&app)
}
/// 原地换装：Windows 允许改名一个正在执行的映像，不允许覆盖它。先挠开再就位，
/// 第二步失败就把第一步撒回去 —— 宁可报错，不留下一个启动不了的目录。
fn swap(staged: &Path) -> update::Result<()> {
    let live = std::env::current_exe()?;
    let replaced = sidecar(&live, REPLACED_SUFFIX);
    if let Err(cause) = std::fs::remove_file(&replaced)
        && cause.kind() != std::io::ErrorKind::NotFound
    {
        return Err(cause.into());
    }
    std::fs::rename(&live, &replaced)?;
    if let Err(cause) = std::fs::rename(staged, &live) {
        std::fs::rename(&replaced, &live)?;
        return Err(cause.into());
    }
    Ok(())
}
/// 换装留下的两样东西：旧映像本进程删不掉，暂存文件在没点重启时会剩下。启动扫一次。
pub fn sweep_binaries() {
    let Ok(live) = std::env::current_exe() else {
        return;
    };
    for suffix in [REPLACED_SUFFIX, STAGED_SUFFIX] {
        let leftover = sidecar(&live, suffix);
        if let Err(cause) = std::fs::remove_file(&leftover)
            && cause.kind() != std::io::ErrorKind::NotFound
        {
            log::debug!("update: {} stayed behind: {cause}", leftover.display());
        }
    }
}
