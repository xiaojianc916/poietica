//! 更新能力。策略与呈现不在这里。
//!
//! 原生侧只回答三件事：有没有新版本、把指定的那一个下下来、装上并重启。何时检查、
//! 要不要提示、长什么样，全部归渲染层。

use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, command};
use tauri_plugin_updater::{Update, UpdaterExt};
use tauri_specta::Event;

use crate::error::{Error, IpcError};

/// 命令面上的错误是 `IpcError`，不是 `crate::error::Error`：后者的变体里带着路径与
/// 系统错误串，经 `error.rs` 那张脱敏表过一遍之后才是契约。
type UpdateCommandResult<T> = Result<T, IpcError>;

/// 只罩住检查请求：检查是一次清单往返，下载是几十 MB，共用一个上限会把下载掐断。
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);

/// 更新的暂存态，进程一份，由 `bootstrap::app` 注册进托管状态。
///
/// 一把锁三种取值：不存在"正在下"与"已下好"同时为真的窗口，也没有第二处副本。
#[derive(Default)]
pub struct UpdateStaging(Mutex<Staging>);

impl std::fmt::Debug for UpdateStaging {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        /* Debug 不打载荷：Staged 里是几十 MB 安装字节，只报到版本为止。 */
        let staging = self.lock();

        match &*staging {
            Staging::Empty => f.write_str("UpdateStaging(Empty)"),
            Staging::Downloading(version) => f
                .debug_tuple("UpdateStaging(Downloading)")
                .field(version)
                .finish(),
            Staging::Staged(staged) => f
                .debug_tuple("UpdateStaging(Staged)")
                .field(&staged.version)
                .finish(),
        }
    }
}

#[derive(Default)]
enum Staging {
    #[default]
    Empty,
    Downloading(String),
    Staged(Box<StagedUpdate>),
}

/// 已经下完、等着人点重启的那一个。
///
/// `Update::install` 要的正是 `download` 吐出的那些字节和产出它们的那个 `Update`，
/// 两者必须一起活到人点下去为止。代价照实说：这期间那几十 MB 待在内存里，这是这套
/// API 的形状决定的。
struct StagedUpdate {
    version: String,
    update: Update,
    bytes: Vec<u8>,
}

/// `begin` 的三种去向。
enum Begin {
    Start,
    Ready,
    Busy,
}

impl UpdateStaging {
    fn lock(&self) -> MutexGuard<'_, Staging> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn begin(&self, version: &str) -> Begin {
        let mut staging = self.lock();

        match &*staging {
            Staging::Staged(staged) if staged.version == version => Begin::Ready,
            Staging::Downloading(_) => Begin::Busy,
            _ => {
                *staging = Staging::Downloading(version.to_owned());

                Begin::Start
            }
        }
    }

    fn finish(&self, staged: StagedUpdate) {
        *self.lock() = Staging::Staged(Box::new(staged));
    }

    /// 只撤自己那一趟，不碰别人后来放进去的东西。
    fn abandon(&self, version: &str) {
        let mut staging = self.lock();

        if matches!(&*staging, Staging::Downloading(pending) if pending == version) {
            *staging = Staging::Empty;
        }
    }

    fn take(&self) -> Option<StagedUpdate> {
        let mut staging = self.lock();

        match std::mem::take(&mut *staging) {
            Staging::Staged(staged) => Some(*staged),
            other => {
                *staging = other;

                None
            }
        }
    }
}

/// 无论从哪条路径退出，都不留下一个没人在下的 `Downloading`。
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

/// 一个可安装的新版本。
#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRelease {
    pub version: String,
    pub notes: Option<String>,
}

/// 下载进度，以百分比表达。总长未知（服务端没给 Content-Length）时为空。
///
/// 跨 IPC 的是这一个标量而不是两个字节数：界面上只出现比值，比值就该是契约上的东
/// 西。事件名与 payload 类型由 `collect_events!` 一并导出；`Event` 派生要求
/// `Deserialize`，它只服务于这条生成通道。
#[derive(Clone, Copy, Debug, Deserialize, Event, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub percent: Option<u8>,
}

/// 已下载字节占总长的百分比，钳在 0..=100。总长未知或为零时为空。
fn percent_of(downloaded: u64, total: Option<u64>) -> Option<u8> {
    let total = total.filter(|bytes| *bytes > 0)?;

    u8::try_from((downloaded.saturating_mul(100) / total).min(100)).ok()
}

/// 更新器的失败原因不外带：错误串里可能有更新源地址、代理与本机落盘路径，界面要说
/// 的那句话不需要它们，日志里有完整的一份。
fn plugin_failure(error: &tauri_plugin_updater::Error) -> IpcError {
    log::warn!("updater failed: {error}");

    Error::Plugin("update failed".to_owned()).into()
}

async fn fetch(app: &AppHandle) -> UpdateCommandResult<Option<Update>> {
    let updater = app.updater().map_err(|error| plugin_failure(&error))?;

    tokio::time::timeout(CHECK_TIMEOUT, updater.check())
        .await
        .map_err(|_elapsed| IpcError::from(Error::Plugin("update check timed out".to_owned())))?
        .map_err(|error| plugin_failure(&error))
}

/// 是否存在比当前版本更新的发布。
///
/// # Errors
///
/// 更新源不可达、超时、清单无法解析或签名校验失败时返回错误。
#[command]
#[specta::specta]
pub async fn update_check(app: AppHandle) -> UpdateCommandResult<Option<UpdateRelease>> {
    Ok(fetch(&app).await?.map(|update| UpdateRelease {
        version: update.version.clone(),
        notes: update.body.clone(),
    }))
}

/// 把 `version` 下下来待命，期间以 `UpdateProgress` 事件广播进度。只下载，不安装。
///
/// 版本是入参，不是"下的时候最新的那一个"：提示给人的和最终装上的必须同一个版本，
/// 两次检查之间发布换了版就报错，而不是悄悄换掉人答应过的东西。
///
/// # Errors
///
/// 该版本已不再是最新、下载失败、签名不匹配，或另一趟下载正在进行时返回错误。
#[command]
#[specta::specta]
pub async fn update_download(app: AppHandle, version: String) -> UpdateCommandResult<()> {
    let staging = app.state::<UpdateStaging>();

    match staging.begin(&version) {
        /* 语义是"让这个版本待命"，已经待命就什么都不用做。 */
        Begin::Ready => return Ok(()),
        Begin::Busy => {
            return Err(Error::Plugin("an update download is in flight".to_owned()).into());
        }
        Begin::Start => {}
    }

    let mut guard = DownloadGuard {
        staging: &staging,
        version: version.clone(),
        armed: true,
    };

    let Some(update) = fetch(&app).await? else {
        return Err(Error::NotFound(format!("release {version} is gone")).into());
    };

    if update.version != version {
        return Err(Error::NotFound(format!("release {version} is no longer the latest")).into());
    }

    let emitter = app.clone();
    let mut downloaded: u64 = 0;
    let mut broadcast: Option<u8> = None;

    let bytes = update
        .download(
            move |chunk, total| {
                downloaded = downloaded.saturating_add(u64::try_from(chunk).unwrap_or(u64::MAX));

                let percent = percent_of(downloaded, total);

                /* 一个 chunk 一次事件是七千多次 IPC，而胶囊上只有 101 个可见值。 */
                if percent == broadcast {
                    return;
                }

                broadcast = percent;

                if let Err(error) = (UpdateProgress { percent }).emit(&emitter) {
                    log::warn!("could not emit update progress: {error}");
                }
            },
            || log::info!("update downloaded; waiting for the user to restart"),
        )
        .await
        .map_err(|error| plugin_failure(&error))?;

    staging.finish(StagedUpdate {
        version,
        update,
        bytes,
    });

    guard.armed = false;

    Ok(())
}

/// 安装已经下好的那一个，然后重启。
///
/// 正常路径上不返回：Windows 的 NSIS 安装器在 passive 模式下会接管进程。
///
/// # Errors
///
/// 没有下好的版本，或安装器启动失败 —— 后者意味着那份字节已被消耗，暂存态一并清空。
#[command]
#[specta::specta]
pub async fn update_relaunch(app: AppHandle) -> UpdateCommandResult<()> {
    let Some(staged) = app.state::<UpdateStaging>().take() else {
        return Err(Error::NotFound("no downloaded update is waiting".to_owned()).into());
    };

    staged
        .update
        .install(staged.bytes)
        .map_err(|error| plugin_failure(&error))?;

    crate::bootstrap::shutdown::relaunch(&app)
}
