//! 磁盘布局的唯一声明处。不读安装器写的声明文件——NSIS 的 FileWrite 输出 UTF-16LE 而这边按
//! UTF-8 读；卸载器 RMDir 不带 /r，数据由用户勾「删除应用数据」清除（installer-hooks.nsh）。

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tauri::{AppHandle, Manager, Runtime};
use uuid::Uuid;

use crate::error::Result;

const SETTINGS_FILE: &str = "settings.json";
const AGENTS_FILE: &str = "agents.json";
const AUTOMATIONS_FILE: &str = "automations.json";

/// WAL 模式下磁盘上是三个文件（本文件加 -wal 与 -shm），备份必须三个一起。
const LEDGER_DATABASE: &str = "ledger.sqlite3";

const LOG_DIRECTORY: &str = "logs";

const TEMP_DIRECTORY: &str = "tmp";

const CACHE_DIRECTORY: &str = "cache";
const CRASH_REPORT_FILE: &str = "last-native-crash.json";
const ATTACHMENTS_DIRECTORY: &str = "attachments";

const LIBRARY_DIRECTORY: &str = "library";
const MARKETPLACE_CATALOG_FILE: &str = "marketplace.json";
const AGENTS_DIRECTORY: &str = "agents";

/// 无项目会话的工作目录根；名字同时由 packages/conversation/src/threads/workspace-root.ts 识别，改名须两侧同步。
const PROJECTLESS_DIRECTORY: &str = "projectless";

/// 受控 home：配置由 agent 自己写、自己热重载，我们只经它的官方 CLI 写入。
const AGENT_HOME_DIRECTORY: &str = "home";

const BROWSER_DIRECTORY: &str = "browser";

/// 内置浏览器的 WebView2 用户数据，与应用 UI webview 的必须分开，混进 EBWebView 就分不出谁是谁的。
const BROWSER_PROFILE_DIRECTORY: &str = "profile";

const SYSTEM_TEMP_DIRECTORY: &str = "poietica";

static ROOT: OnceLock<PathBuf> = OnceLock::new();

/// 安装时选定的根（exe 旁）。开发构建返回 None：不能往 target/ 写用户数据；用 cfg! 让两条分支都参与编译。
fn installed_root() -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        return None;
    }

    Some(std::env::current_exe().ok()?.parent()?.to_path_buf())
}

fn root<R: Runtime>(app: &AppHandle<R>) -> Result<&'static Path> {
    if let Some(known) = ROOT.get() {
        return Ok(known.as_path());
    }

    let resolved = match installed_root() {
        Some(chosen) => chosen,
        None => app.path().app_local_data_dir()?,
    };

    fs::create_dir_all(&resolved)?;

    Ok(ROOT.get_or_init(|| resolved).as_path())
}

pub fn data_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    Ok(root(app)?.to_path_buf())
}

pub fn settings_store<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    Ok(root(app)?.join(SETTINGS_FILE))
}

/// Agent 接入档案与安装状态缓存；密钥不在其中。
pub fn agents_store<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    Ok(root(app)?.join(AGENTS_FILE))
}

pub fn automations_store<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    Ok(root(app)?.join(AUTOMATIONS_FILE))
}

pub fn ledger_database<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    Ok(root(app)?.join(LEDGER_DATABASE))
}

pub fn log_directory<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let directory = root(app)?.join(LOG_DIRECTORY);

    fs::create_dir_all(&directory)?;

    Ok(directory)
}

pub fn crash_report<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    Ok(log_directory(app)?.join(CRASH_REPORT_FILE))
}

pub fn temp_directory<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let directory = root(app)?.join(TEMP_DIRECTORY);

    fs::create_dir_all(&directory)?;

    Ok(directory)
}

pub fn reset_temp_directory<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let _swept = fs::remove_dir_all(root(app)?.join(TEMP_DIRECTORY));

    temp_directory(app)
}

/// 只放丢了能重新取回的东西；没人自动清，清理是用户在关于面板上的一次动作。
pub fn cache_directory<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let directory = root(app)?.join(CACHE_DIRECTORY);

    fs::create_dir_all(&directory)?;

    Ok(directory)
}

/// 字节不跟着对话删：删对话只解开索引链接，引用归零才由 thread.rs 的清扫回收字节。
pub fn attachments_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let directory = root(app)?.join(ATTACHMENTS_DIRECTORY);

    fs::create_dir_all(&directory)?;

    Ok(directory)
}

pub fn library_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let directory = root(app)?.join(LIBRARY_DIRECTORY);

    fs::create_dir_all(&directory)?;

    Ok(directory)
}

/// 路径由 Rust 算、不由渲染层传：写配置的 CLI 与起会话的连接必须落在同一个 home。
pub fn agent_home<R: Runtime>(app: &AppHandle<R>, agent_id: &str) -> Result<PathBuf> {
    let directory = root(app)?
        .join(AGENTS_DIRECTORY)
        .join(agent_id)
        .join(AGENT_HOME_DIRECTORY);

    fs::create_dir_all(&directory)?;

    Ok(directory)
}

pub fn marketplace_catalog<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    Ok(cache_directory(app)?.join(MARKETPLACE_CATALOG_FILE))
}

/// 目录与会话同寿、跨重启保留（会话恢复需要原 cwd），不是本模块的 tmp。
pub fn create_projectless_workspace<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let parent = root(app)?.join(PROJECTLESS_DIRECTORY);

    fs::create_dir_all(&parent)?;

    let directory = parent.join(Uuid::now_v7().to_string());

    fs::create_dir(&directory)?;

    Ok(directory)
}

/// 只回收本应用签发的目录（projectless 下、名字是 UUID）；库里的字符串什么都能装，其余原样留下。
pub fn remove_projectless_workspace<R: Runtime>(
    app: &AppHandle<R>,
    recorded: &str,
) -> Result<bool> {
    let candidate = PathBuf::from(recorded);

    let housed = candidate.parent() == Some(root(app)?.join(PROJECTLESS_DIRECTORY).as_path());

    if !housed || projectless_identity(&candidate).is_none() {
        return Ok(false);
    }

    match fs::remove_dir_all(&candidate) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

/// 启动对账的快照一半：先拍快照、后读引用名单（bootstrap/app.rs），快照后新签发的目录不会被判孤儿。
pub fn projectless_workspaces<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<PathBuf>> {
    let parent = root(app)?.join(PROJECTLESS_DIRECTORY);

    let entries = match fs::read_dir(&parent) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };

    let mut found = Vec::new();

    for entry in entries {
        let path = entry?.path();

        if path.is_dir() && projectless_identity(&path).is_some() {
            found.push(path);
        }
    }

    Ok(found)
}

#[must_use]
pub fn sweep_projectless_workspaces(snapshot: Vec<PathBuf>, referenced: &[String]) -> usize {
    let kept: HashSet<Uuid> = referenced
        .iter()
        .filter_map(|recorded| projectless_identity(Path::new(recorded)))
        .collect();

    let mut swept = 0_usize;

    for path in snapshot {
        let Some(identity) = projectless_identity(&path) else {
            continue;
        };

        if kept.contains(&identity) {
            continue;
        }

        match fs::remove_dir_all(&path) {
            Ok(()) => swept = swept.saturating_add(1),
            Err(error) => {
                log::warn!("could not remove an orphaned projectless directory: {error}");
            }
        }
    }

    swept
}

/// 判据与 packages/conversation/src/threads/workspace-root.ts 的 isProjectlessWorkspaceRoot 同一条（末段是 UUID），两侧须同步改。
fn projectless_identity(candidate: &Path) -> Option<Uuid> {
    candidate
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| Uuid::parse_str(name).ok())
}

pub fn browser_profile<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let directory = root(app)?
        .join(BROWSER_DIRECTORY)
        .join(BROWSER_PROFILE_DIRECTORY);

    fs::create_dir_all(&directory)?;

    Ok(directory)
}

/// 交给 agent 读一次的中转物：落系统临时目录而非数据根，不是用户数据，不进备份。
pub fn write_element_report(report: &str) -> Result<PathBuf> {
    let directory = std::env::temp_dir().join(SYSTEM_TEMP_DIRECTORY);

    fs::create_dir_all(&directory)?;

    let path = directory.join(format!("element-{}.txt", Uuid::now_v7().simple()));

    fs::write(&path, report)?;

    Ok(path)
}

pub(crate) fn automation_lock(app: &AppHandle) -> Result<PathBuf> {
    Ok(data_root(app)?.join("automation.lock"))
}
