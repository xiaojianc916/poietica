//! 磁盘布局：数据根由宿主给，这里只在它下面拼出各处的名字。
//!
//! 宿主事实（三个目录）也住这里：它们是**路径**，不是服务。放在这一层是为了让
//! 「谁持有唯一真相」这句话有一个方向明确的落点 —— 单例的读写若散在上层，
//! 模块图必然成环（命令层要调会话层，会话层又要回头问宿主状态）。
//!
//! 数据根是宿主的 userData（apps/desktop/electron/main.ts），不在安装目录里：
//! 安装器与卸载器只碰程序文件，升级换的是那个目录，碰不到这里。

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use napi_derive::napi;

/// 宿主交进来的三个目录事实。
#[napi(object)]
pub struct HostPaths {
    /// 应用自己的数据根；设置、账本、附件、agent 受控 home 都在它下面。
    pub data_root: String,
    /// 用户主目录。只有 agent 自己的 home 需要它。
    pub home_directory: String,
    /// 随包发的运行时目录（bun.exe、桥的入口、pi-natives 的 .node）。
    pub bundled_directory: String,
    /// 应用日志目录。**由宿主定** —— Electron 的 `app.getPath('logs')` 是它的官方产地，
    /// 主进程自己也往这里写（electron-log），两侧必须落在同一个目录，所以它像数据根一样
    /// 是交进来的事实，不是原生侧拼出来的名字。
    pub log_directory: String,
}

/// 手写 Debug：`#[napi(object)]` 不生成它，而这三个字段里没有一样是秘密。
impl std::fmt::Debug for HostPaths {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HostPaths")
            .field("data_root", &self.data_root)
            .field("home_directory", &self.home_directory)
            .field("bundled_directory", &self.bundled_directory)
            .field("log_directory", &self.log_directory)
            .finish()
    }
}

use uuid::Uuid;

use crate::error::{Error, Result};

const SETTINGS_FILE: &str = "settings.json";

/// agent 接入档案。可手改，是 agent-catalog 描述符在本盘的物化，不是第二份真相。
const AGENTS_FILE: &str = "agents.json";

/// WAL 模式下磁盘上是三个文件（本文件加 -wal 与 -shm），备份必须三个一起。
const LEDGER_DATABASE: &str = "ledger.sqlite3";

const TEMP_DIRECTORY: &str = "tmp";

const CACHE_DIRECTORY: &str = "cache";
const ATTACHMENTS_DIRECTORY: &str = "attachments";

/// 本应用自己装的本机工具（解释器等），与 agent 的受控 home 分开。
const TOOLS_DIRECTORY: &str = "tools";
const PYTHON_DIRECTORY: &str = "python";

const MARKETPLACE_CATALOG_FILE: &str = "marketplace.json";

/// 受控 home 的目录名：配置由 agent 自己写、自己热重载，我们只经它的官方 CLI 写入。
/// 名字同时由 apps/desktop/electron/storage.ts 读，改名须两侧同步。
const AGENT_HOME_DIRECTORY: &str = "agents";

/// 无项目会话的工作目录根；名字同时由 packages/conversation/src/threads/workspace-root.ts 识别，改名须两侧同步。
const PROJECTLESS_DIRECTORY: &str = "projectless";

const SYSTEM_TEMP_DIRECTORY: &str = "poietica";

/// 宿主交进来的三个目录事实。只有宿主知道数据根在哪，原生侧不猜。
static HOST: OnceLock<HostPaths> = OnceLock::new();

/// 记下宿主事实。`NativeHost.start` 只调一次。
pub(crate) fn install_host_facts(paths: HostPaths) -> Result<()> {
    HOST.set(paths)
        .map_err(|_| Error::Internal("the host facts were already installed".to_owned()))
}

fn host() -> Result<&'static HostPaths> {
    HOST.get()
        .ok_or_else(|| Error::Internal("the native side has no host facts yet".to_owned()))
}

/// 数据根。开发构建与安装构建不同，只有宿主知道它在哪。
pub fn data_root() -> Result<PathBuf> {
    let root = PathBuf::from(&host()?.data_root);

    fs::create_dir_all(&root)?;

    Ok(root)
}

/// 用户主目录。只有 agent 自己的 home 需要它。
pub fn home_directory() -> Result<PathBuf> {
    Ok(PathBuf::from(&host()?.home_directory))
}

/// 随包发的运行时目录（bun.exe、桥的入口、pi-natives 的 .node）。
pub fn bundled_directory() -> Result<PathBuf> {
    Ok(PathBuf::from(&host()?.bundled_directory))
}

pub fn settings_store() -> Result<PathBuf> {
    Ok(data_root()?.join(SETTINGS_FILE))
}

/// Agent 接入档案与安装检查缓存；密钥不在其中。
pub fn agents_store() -> Result<PathBuf> {
    Ok(data_root()?.join(AGENTS_FILE))
}

pub fn ledger_database() -> Result<PathBuf> {
    Ok(data_root()?.join(LEDGER_DATABASE))
}

/// 应用日志目录。宿主交进来（Electron 的 `app.getPath('logs')`），主进程与原生侧落同一处。
pub fn log_directory() -> Result<PathBuf> {
    let directory = PathBuf::from(&host()?.log_directory);

    fs::create_dir_all(&directory)?;

    Ok(directory)
}

pub fn temp_directory() -> Result<PathBuf> {
    let directory = data_root()?.join(TEMP_DIRECTORY);

    fs::create_dir_all(&directory)?;

    Ok(directory)
}

pub fn reset_temp_directory() -> Result<PathBuf> {
    let _swept = fs::remove_dir_all(data_root()?.join(TEMP_DIRECTORY));

    temp_directory()
}

/// 通用文件发送前的暂存根：在 tmp 下，随启动对账清空（workspace/reconcile.rs）。
/// 图片走内存注册表不落地这里；这里只放不进展示协议的文件字节。
pub fn composer_staging_root() -> Result<PathBuf> {
    let directory = temp_directory()?.join("composer-attachments");

    fs::create_dir_all(&directory)?;

    Ok(directory)
}

/// 只放丢了能重新取回的东西；没人自动清，清理是用户在关于面板上的一次动作。
pub fn cache_directory() -> Result<PathBuf> {
    let directory = data_root()?.join(CACHE_DIRECTORY);

    fs::create_dir_all(&directory)?;

    Ok(directory)
}

/// 字节不跟着对话删：删对话只解开索引链接，引用归零才由 thread.rs 的清扫回收字节。
pub fn attachments_root() -> Result<PathBuf> {
    let directory = data_root()?.join(ATTACHMENTS_DIRECTORY);

    fs::create_dir_all(&directory)?;

    Ok(directory)
}

/// 路径由 Rust 算、不由渲染层传：写配置的 CLI 与起会话的连接必须落在同一个 home。
///
/// 它自己就是那个 home，没有「按 agent 分一层」的 `<id>/` 与「home 这一层」：这个软件
/// 只接一家 agent（ADR 0016、0042），两层目录只是把同一件事实重说两遍。agent 的配置、
/// 会话、技能与插件都直接住在它下面。
pub fn agent_home() -> Result<PathBuf> {
    let directory = data_root()?.join(AGENT_HOME_DIRECTORY);

    fs::create_dir_all(&directory)?;

    Ok(directory)
}

/// 内置 Python 内核的受管落点。不放 agent_home：那是 omp 的受控 home，配置由它自己
/// 写、自己热重载；解释器是我们的资产，装在这里，路径再喂给它的设置。
pub fn managed_python_directory() -> Result<PathBuf> {
    Ok(data_root()?.join(TOOLS_DIRECTORY).join(PYTHON_DIRECTORY))
}

pub fn marketplace_catalog() -> Result<PathBuf> {
    Ok(cache_directory()?.join(MARKETPLACE_CATALOG_FILE))
}

/// 无项目工作区的根；Runtime 连接没有工作区时退到这里，不退到用户主目录。
pub fn projectless_root() -> Result<PathBuf> {
    let parent = data_root()?.join(PROJECTLESS_DIRECTORY);

    fs::create_dir_all(&parent)?;

    Ok(parent)
}

/// 目录与会话同寿、跨重启保留（会话恢复需要原 cwd），不是本模块的 tmp。
pub fn create_projectless_workspace() -> Result<PathBuf> {
    let parent = projectless_root()?;
    let directory = parent.join(Uuid::now_v7().to_string());

    fs::create_dir(&directory)?;

    Ok(directory)
}

/// 只回收本应用签发的目录（projectless 下、名字是 UUID)；库里的字符串什么都能装，其余原样留下。
pub fn remove_projectless_workspace(recorded: &str) -> Result<bool> {
    let candidate = PathBuf::from(recorded);

    let housed = candidate.parent() == Some(data_root()?.join(PROJECTLESS_DIRECTORY).as_path());

    if !housed || projectless_identity(&candidate).is_none() {
        return Ok(false);
    }

    match fs::remove_dir_all(&candidate) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

/// 启动对账的快照一半：先拍快照、后读引用名单（bootstrap.rs），快照后新签发的目录不会被判孤儿。
pub fn projectless_workspaces() -> Result<Vec<PathBuf>> {
    let parent = data_root()?.join(PROJECTLESS_DIRECTORY);

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
                tracing::warn!("could not remove an orphaned projectless directory: {error}");
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

/// 交给 agent 读一次的中转物：落系统临时目录而非数据根，不是用户数据，不进备份。
pub fn write_element_report(report: &str) -> Result<PathBuf> {
    let directory = std::env::temp_dir().join(SYSTEM_TEMP_DIRECTORY);

    fs::create_dir_all(&directory)?;

    let path = directory.join(format!("element-{}.txt", Uuid::now_v7().simple()));

    fs::write(&path, report)?;

    Ok(path)
}

pub(crate) fn automation_lock() -> Result<PathBuf> {
    Ok(data_root()?.join("automation.lock"))
}
