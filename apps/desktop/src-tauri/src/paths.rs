//! 这个应用在磁盘上占了哪些位置——唯一的声明处。一个根，一个位置：用户要备份、
//! 搬机器、抹干净，需要知道的路径只有一条。
//!
//! 安装版的根是可执行文件所在目录：安装器目录页的一次选择同时回答「程序装到哪」与
//! 「数据存到哪」。不读安装器写的声明文件——NSIS 的 FileWrite 输出 UTF-16LE 而这边按
//! UTF-8 读，换成「exe 在哪数据就在哪」之后没有可错的地方。卸载不带走数据：卸载器的
//! RMDir 不带 /r，要清干净得由用户勾「删除应用数据」，那一条在 installer-hooks.nsh 里处置。
//!
//! 开发构建 exe 在 target/debug 下，不适用上面这条：落点固定为平台目录，identifier 由
//! tauri.dev.conf.json 覆盖成带 .dev 后缀的形式——开发与安装版因此不会同时打开同一个
//! WAL 库，也不会互相覆盖 settings.json 与 agent 凭据。目录名不在此重复：
//! `app_local_data_dir()` 返回的就是本地数据目录拼上 identifier，identifier 归配置管，
//! 在这里再写一份常量等于同一件事有两个真相。

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

/// 账本：事件、准入、投递、游标与索引投影表，全进程一个库文件。不加密、不存对话
/// 内容；WAL 模式下磁盘上是三个文件（本文件加 -wal 与 -shm），备份必须三个一起。
const LEDGER_DATABASE: &str = "ledger.sqlite3";

const LOG_DIRECTORY: &str = "logs";

/// 本次运行的中转盘。进程退出它就没有意义了，所以启动时清空。
const TEMP_DIRECTORY: &str = "tmp";

/// 丢了也不会少任何东西的副本。跨运行保留。
const CACHE_DIRECTORY: &str = "cache";
const CRASH_REPORT_FILE: &str = "last-native-crash.json";
const ATTACHMENTS_DIRECTORY: &str = "attachments";

const LIBRARY_DIRECTORY: &str = "library";
const MARKETPLACE_CATALOG_FILE: &str = "marketplace.json";
const AGENTS_DIRECTORY: &str = "agents";

/// 无项目会话的工作目录根。
///
/// 这个名字同时由 packages/conversation/src/threads/workspace-root.ts 识别；复制处
/// 带着正本路径，任一侧改名时必须同步修改。
const PROJECTLESS_DIRECTORY: &str = "projectless";

/// 受控 home：agent 自己的 CLI 往这里写它自己的配置文件，由它自己热重载。
const AGENT_HOME_DIRECTORY: &str = "home";

const BROWSER_DIRECTORY: &str = "browser";

/// WebView2 用户数据目录（Cookie、站点存储、内核缓存）。与应用 UI webview 的用户数据
/// 分开是硬要求：这一份属于「用户在面板里逛过哪些网站」，寿命、备份与清除都跟着数据根
/// 走，混进 EBWebView 就再也分不出谁是谁的。
const BROWSER_PROFILE_DIRECTORY: &str = "profile";

const SYSTEM_TEMP_DIRECTORY: &str = "poietica";

/// 根解析一次就固定。它在进程存续期间不会变，而每条命令都要问它。
static ROOT: OnceLock<PathBuf> = OnceLock::new();

/// 安装时选定的根，即可执行文件旁边。开发构建返回 None：exe 在 target/debug 下，
/// 往那里写用户数据既会被 cargo clean 抹掉，也会跟着构建产物进版本库。用 cfg! 而非
/// 两份 #[cfg] 函数体，是让两条分支都参与编译，不会有一侧变成没人发现的死代码。
fn installed_root() -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        return None;
    }

    Some(std::env::current_exe().ok()?.parent()?.to_path_buf())
}

/// 这个应用的数据根，创建后返回。关于面板要把它显示给用户，所以它是公开的。
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

/// 数据根本身。关于面板要把它显示给用户，所以它是公开的。
///
/// # Errors
///
/// 平台目录无法解析、或根目录无法创建时返回错误。
pub fn data_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    Ok(root(app)?.to_path_buf())
}

/// 用户可见设置。
pub fn settings_store<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    Ok(root(app)?.join(SETTINGS_FILE))
}

/// Agent 接入档案与安装状态缓存。密钥不在其中。
pub fn agents_store<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    Ok(root(app)?.join(AGENTS_FILE))
}

/// 自动化定义。运行记录只在其中留指针，正文在对话里。
pub fn automations_store<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    Ok(root(app)?.join(AUTOMATIONS_FILE))
}

/// 账本库的位置。
pub fn ledger_database<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    Ok(root(app)?.join(LEDGER_DATABASE))
}

/// 日志目录，创建后返回。
pub fn log_directory<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let directory = root(app)?.join(LOG_DIRECTORY);

    fs::create_dir_all(&directory)?;

    Ok(directory)
}

/// 上一次原生崩溃的报告。与日志同目录：它是诊断产物，不是用户数据。
pub fn crash_report<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    Ok(log_directory(app)?.join(CRASH_REPORT_FILE))
}

/// 临时目录，创建后返回。清空的时机见 `reset_temp_directory`。
pub fn temp_directory<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let directory = root(app)?.join(TEMP_DIRECTORY);

    fs::create_dir_all(&directory)?;

    Ok(directory)
}

/// 抹掉上一次运行留下的中转文件，重建后返回；启动杂务调用一次。抹得掉才抹：被别的
/// 进程占着的临时文件最坏多活一轮，远好过启动失败。单实例插件保证同时只有一个我们
/// 自己的进程，不会抹掉另一个自己正在用的东西。
pub fn reset_temp_directory<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let _swept = fs::remove_dir_all(root(app)?.join(TEMP_DIRECTORY));

    temp_directory(app)
}

/// 缓存目录，创建后返回。这里放「丢了还能重新取回来」的东西，判据是这一条而非大小
/// 或常用度——用户数据再小也不进这里。没有人自动清：每一项都该能被独立丢掉，清理是
/// 用户在关于面板上的一次动作，不是启动时的一次副作用。
pub fn cache_directory<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let directory = root(app)?.join(CACHE_DIRECTORY);

    fs::create_dir_all(&directory)?;

    Ok(directory)
}

/// 附件字节的根，内容寻址 `<root>/<hash 前两位>/<hash>`，创建后返回。两级散列不是
/// 装饰：单目录堆上几万个条目后 NTFS 的枚举与创建都会明显变慢。字节不跟着对话删——
/// 同一张图可能还挂在别的对话上，删对话只解开索引里的链接，引用归零才轮到字节
/// （thread.rs 的 unreferenced_attachments + forget_blob 顺手扫掉）。
pub fn attachments_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let directory = root(app)?.join(ATTACHMENTS_DIRECTORY);

    fs::create_dir_all(&directory)?;

    Ok(directory)
}

/// 资料库的根，创建后返回。位置不由用户选：资料是本应用的数据，跟着数据根走。
pub fn library_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let directory = root(app)?.join(LIBRARY_DIRECTORY);

    fs::create_dir_all(&directory)?;

    Ok(directory)
}

/// 这个 agent 的受控 home，创建后返回。路径由 Rust 算、不由渲染层传：写 provider 的
/// CLI 与起会话的连接必须落在同一个目录，否则配置写进了一个 home、对话读的是另一个。
pub fn agent_home<R: Runtime>(app: &AppHandle<R>, agent_id: &str) -> Result<PathBuf> {
    let directory = root(app)?
        .join(AGENTS_DIRECTORY)
        .join(agent_id)
        .join(AGENT_HOME_DIRECTORY);

    fs::create_dir_all(&directory)?;

    Ok(directory)
}

/// 上一次拉到的市场目录。拉过一次就不再自动拉，刷新是用户的动作。
pub fn marketplace_catalog<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    Ok(cache_directory(app)?.join(MARKETPLACE_CATALOG_FILE))
}

/// 为一条新的无项目会话创建独立工作目录。目录跨应用重启保留：会话恢复时 agent 仍然
/// 需要原来的 cwd。它不是本模块的 tmp——tmp 每次启动都会被清空，而这份目录与会话同寿。
pub fn create_projectless_workspace<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let parent = root(app)?.join(PROJECTLESS_DIRECTORY);

    fs::create_dir_all(&parent)?;

    let directory = parent.join(Uuid::now_v7().to_string());

    fs::create_dir(&directory)?;

    Ok(directory)
}

/// 删除对话时回收它的无项目工作目录。只认自己签发的形状：数据根下 projectless 里、
/// 名字是一个 UUID 的目录。库里那一格什么字符串都可能装——项目目录、旧默认工作区都会
/// 从这里路过，一律原样留下：删的是应用自己造的目录，不是用户的。目录已经不在按已回收算。
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

/// 此刻存在的全部无项目工作目录。启动对账的快照那一半：先拍快照、后读引用名单
/// （bootstrap/app.rs），快照之后才签发的目录不在其中，「刚签出去、行还没落库」的
/// 目录因此不会被当成孤儿。
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

/// 快照里没有任何对话引用的目录，删掉，交回删掉的数目。单个目录删不掉只记日志不返错：
/// 一个正被占着的目录最坏多活一轮，下一次启动再来，远好过让启动失败——与
/// reset_temp_directory 抹 tmp 同一条规矩。
#[must_use]
pub fn sweep_projectless_workspaces(snapshot: Vec<PathBuf>, referenced: &[String]) -> usize {
    // 按 UUID 比对而非路径字符串：UUID 是这些目录唯一与写法无关的身份，路径在库与
    // 磁盘之间每多走一趟就多一种写法。
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

/// 这条路径的末段是不是本应用签发的无项目目录名。判据与
/// packages/conversation/src/threads/workspace-root.ts 的 isProjectlessWorkspaceRoot
/// 同一条（目录名是一个 UUID），任一侧改动时必须同步修改。
fn projectless_identity(candidate: &Path) -> Option<Uuid> {
    candidate
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| Uuid::parse_str(name).ok())
}

/// 内置浏览器的 WebView2 profile，创建后返回。
pub fn browser_profile<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    let directory = root(app)?
        .join(BROWSER_DIRECTORY)
        .join(BROWSER_PROFILE_DIRECTORY);

    fs::create_dir_all(&directory)?;

    Ok(directory)
}

/// 把一次元素拾取的完整快照写进系统临时目录，返回它的路径。落在系统临时目录而不是
/// 数据根的 tmp：这是交给 agent 读一次的中转物，不是用户数据，不进备份，寿命由系统
/// 的临时目录回收策略管。
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
