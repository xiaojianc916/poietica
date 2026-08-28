//! agent 运行时的安装与更新。
//!
//! 这不是 `agent_cli_exec` 的放宽版，也永远不该并进去。那条管线的白名单说的是
//! 「provider 子命令」；把一次全局安装塞进那张表，等于把一个受控入口改成通用执行
//! 入口。这里是第二条同样封闭的管线：包名由 agents.json 的档案声明，程序只可能是
//! bun、pnpm、npm 三者之一，渲染层能说的只有「装哪个 agent」。
//!
//! ## 用哪个包管理器，不是猜出来的，是查出来的
//!
//! PATH 上的 kimi 只是一个 shim，它归谁管取决于当初是谁放的。用 npm 去升级一份
//! pnpm 装的运行时，不会升级它，只会在 npm 的 prefix 里放第二个同名 shim：两份
//! 同时在 PATH 上，谁生效由 PATH 顺序决定，于是界面说新版本、进程跑旧版本，而且
//! 一声不吭。所以归属从已解析出的那个文件反查 —— 它的目录落在谁的全局 bin 里，
//! 它就归谁。
//!
//! 三家都不是（官方安装脚本、Homebrew、手工放的）就是 External：装了，但不归
//! 我们管。这种情况下一个按钮都不画 —— 替用户装第二份是比不作为更坏的结果。
//!
//! 还没装时才需要挑一个，顺序是 bun、pnpm、npm。npm 随 Node.js 必然存在，把它当
//! 默认等于对每一个刻意装过别家的人都装错地方。
//!
//! ## 检测频率
//!
//! 最新版本问包管理器自己（view），不是我们手写的 HTTP 请求：registry、镜像、代理
//! 与企业证书全在它的配置里，绕过去就是在国内镜像下必然检测失败。结果缓存 24 小时，
//! 落在 agents.json。打开设置页读缓存（零网络零进程），过期才问一次，安装成功后强制
//! 失效。不轮询 —— 这是 npm update-notifier 的默认间隔与 Homebrew
//! `HOMEBREW_AUTO_UPDATE_SECS` 的同一个量级。全局 bin 目录只查一次，一次会话内不变。

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use specta::Type;
use tauri::{AppHandle, async_runtime, command};
use tauri_plugin_store::StoreExt;

use crate::error::{Error, Result};
use crate::paths::agents_store;
use poietica_agent_runtime_native::hide_console;
use poietica_problem::Problem;

use super::profile::{agent_install_spec, agent_program};

const CHECK_KEY: &str = "installChecks";
const CHECK_TTL_MS: i64 = 24 * 60 * 60 * 1000;
/// 检测不该把界面挂住。安装没有这道闸：它本来就可能跑几分钟。
const FETCH_TIMEOUT: &str = "--fetch-timeout=8000";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PackageManager {
    Bun,
    Pnpm,
    Npm,
}

impl PackageManager {
    /// 顺序即优先级，只在「还没装」时用得上。理由见模块头。
    const ALL: [Self; 3] = [Self::Bun, Self::Pnpm, Self::Npm];

    fn program(self) -> &'static str {
        match self {
            Self::Bun => "bun",
            Self::Pnpm => "pnpm",
            Self::Npm => "npm",
        }
    }

    fn resolved(self) -> Option<PathBuf> {
        poietica_agent_runtime_native::resolve_program(self.program()).ok()
    }

    /// 装到一个具体版本，而不是把 latest 这个标签交回去。
    ///
    /// latest 由谁解析是有分歧的：我们这一侧 view 出来是 0.31.1，包管理器自己再解析
    /// 一次可能因为元数据缓存落到 0.31.0 —— 退出码 0，版本却没到位，界面只好把同一个
    /// 按钮再画一次。这一次流程里已经解析过最新版，就把那个具体版本号交下去；查不到
    /// 时才退回 latest，让包管理器自己决定。
    fn install_args(self, package: &str, version: Option<&str>) -> Vec<String> {
        let target = match version {
            Some(version) => format!("{package}@{version}"),
            None => format!("{package}@latest"),
        };

        match self {
            Self::Bun | Self::Pnpm => vec!["add".to_owned(), "--global".to_owned(), target],
            Self::Npm => vec![
                "install".to_owned(),
                "--global".to_owned(),
                target,
                "--no-fund".to_owned(),
                "--no-audit".to_owned(),
            ],
        }
    }

    fn view_args(self, package: &str) -> Vec<String> {
        /* 动词各家不同：bun 是 info，pnpm 与 npm 是 view。 */
        let verb = match self {
            Self::Bun => "info",
            Self::Pnpm | Self::Npm => "view",
        };

        let mut args = vec![
            verb.to_owned(),
            package.to_owned(),
            "version".to_owned(),
            "--json".to_owned(),
        ];

        /* --fetch-timeout 是 npm 的旗标，另外两家的超时在各自的配置里。 */
        if self == Self::Npm {
            args.push(FETCH_TIMEOUT.to_owned());
        }

        args
    }

    /// 这个包管理器把全局可执行文件放在哪。
    fn global_bin(self) -> Option<PathBuf> {
        let program = self.resolved()?;

        let query = match self {
            Self::Bun => vec!["pm".to_owned(), "bin".to_owned(), "-g".to_owned()],
            Self::Pnpm => vec!["bin".to_owned(), "--global".to_owned()],
            /* npm bin -g 在 npm 9 里被删了。prefix 是它现在还答得上的那个问题。 */
            Self::Npm => vec!["prefix".to_owned(), "--global".to_owned()],
        };

        let spoken = output_of(&program, &query)?;
        let line = spoken
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())?;

        let root = PathBuf::from(line);

        Some(match self {
            Self::Bun | Self::Pnpm => root,
            /* Unix 上 npm 的可执行文件在 prefix/bin，Windows 上就在 prefix 里。 */
            Self::Npm if cfg!(windows) => root,
            Self::Npm => root.join("bin"),
        })
    }
}

/// 两个包管理器的全局 bin 目录。一次会话查一次 —— 它在进程存续期间不会变。
fn global_bins() -> &'static [(PackageManager, PathBuf)] {
    static BINS: OnceLock<Vec<(PackageManager, PathBuf)>> = OnceLock::new();

    BINS.get_or_init(|| {
        PackageManager::ALL
            .iter()
            .filter_map(|manager| manager.global_bin().map(|dir| (*manager, dir)))
            .collect()
    })
}

/// 这个可执行文件是谁装的。
///
/// 规范化的是它所在的目录，不是它本身：pnpm 的全局 bin 里放的是指向内容寻址仓库的
/// 符号链接，把文件本身 canonicalize 掉，就再也认不出它原本挂在谁的 bin 下面。
fn owner_of(executable: &Path) -> Option<PackageManager> {
    let home = executable.parent()?.canonicalize().ok()?;

    global_bins()
        .iter()
        .find(|(_manager, dir)| {
            dir.canonicalize()
                .is_ok_and(|dir| home == dir || home.starts_with(&dir))
        })
        .map(|(manager, _dir)| *manager)
}

fn preferred_manager() -> Option<PackageManager> {
    PackageManager::ALL
        .iter()
        .copied()
        .find(|manager| manager.resolved().is_some())
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AgentInstallState {
    /// 档案没说这东西怎么装。界面什么都不画。
    Unmanaged,
    Missing,
    Outdated,
    Current,
    /// 装着，但不是 bun、pnpm、npm 装的。我们不碰别人的安装。
    External,
    /// 装着，但问不到最新版（离线、镜像不通），或者它的 --version 读不懂。
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstallStatus {
    pub state: AgentInstallState,
    pub installed_version: Option<String>,
    pub latest_version: Option<String>,
    pub package_name: Option<String>,
}

impl AgentInstallStatus {
    fn plain(state: AgentInstallState) -> Self {
        Self {
            state,
            installed_version: None,
            latest_version: None,
            package_name: None,
        }
    }
}

fn now_ms() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(0)
}

/// 一段输出里第一个说得通的 semver。
///
/// 各家 --version 的排版不一样（"kimi-code 1.4.2"、"v1.4.2"、带 build 后缀），
/// 但版本号本身是标准的，所以判据交给 semver，而不是猜排版。
fn first_semver(text: &str) -> Option<String> {
    text.split(|glyph: char| glyph.is_whitespace() || "(),".contains(glyph))
        .map(|token| token.trim_start_matches('v'))
        .find(|token| semver::Version::parse(token).is_ok())
        .map(str::to_owned)
}

fn output_of(program: &Path, args: &[String]) -> Option<String> {
    let mut command = Command::new(program);
    command.args(args);
    hide_console(&mut command);

    let output = command.output().ok()?;
    let mut spoken = String::from_utf8_lossy(&output.stdout).into_owned();
    spoken.push('\n');
    spoken.push_str(&String::from_utf8_lossy(&output.stderr));

    Some(spoken)
}

fn latest_version(manager: PackageManager, package: &str) -> Result<String> {
    let program = manager
        .resolved()
        .ok_or_else(|| Error::AgentCli(format!("这台电脑上没有找到 {}", manager.program())))?;

    let spoken = output_of(&program, &manager.view_args(package))
        .ok_or_else(|| Error::AgentCli(format!("{} 没有执行成功", manager.program())))?;

    /*
     * --json 下给的是一个字符串，多版本匹配时是一个数组。两家的实现都可能在前面先
     * 打一行提示，所以读不成 JSON 时退回「扫出第一个 semver」——判据仍然是 semver，
     * 不是排版。
     */
    let parsed: Option<Value> = serde_json::from_str(spoken.trim()).ok();

    let version = match parsed {
        Some(Value::String(one)) => Some(one),
        Some(Value::Array(many)) => many.last().and_then(Value::as_str).map(str::to_owned),
        _ => first_semver(&spoken),
    };

    version.ok_or_else(|| Error::AgentCli(format!("{package} 的最新版本问不出来")))
}

fn cached_latest(app: &AppHandle, agent_id: &str) -> Option<(String, i64)> {
    let store = app.store(agents_store(app).ok()?).ok()?;
    let table = store.get(CHECK_KEY)?;
    let record = table.get(agent_id)?;

    Some((
        record.get("latestVersion")?.as_str()?.to_owned(),
        record.get("checkedAt")?.as_i64()?,
    ))
}

fn remember_latest(app: &AppHandle, agent_id: &str, version: &str, checked_at: i64) {
    let Ok(path) = agents_store(app) else {
        return;
    };

    let Ok(store) = app.store(path) else {
        return;
    };

    let mut table = store
        .get(CHECK_KEY)
        .unwrap_or_else(|| Value::Object(Map::new()));

    if let Some(entries) = table.as_object_mut() {
        entries.insert(
            agent_id.to_owned(),
            json!({ "latestVersion": version, "checkedAt": checked_at }),
        );

        store.set(CHECK_KEY, table);
        let _saved = store.save();
    }
}

fn compute(app: &AppHandle, agent_id: &str, force: bool) -> Result<AgentInstallStatus> {
    let Some(spec) = agent_install_spec(app, agent_id)? else {
        return Ok(AgentInstallStatus::plain(AgentInstallState::Unmanaged));
    };

    let program = agent_program(app, agent_id)?;

    /* 解析处只有一个：kap 会话与 provider CLI 起的也是它解析出的那份。 */
    let Ok(resolved) = poietica_agent_runtime_native::resolve_program(&program) else {
        return Ok(AgentInstallStatus {
            state: AgentInstallState::Missing,
            package_name: Some(spec.package_name),
            ..AgentInstallStatus::plain(AgentInstallState::Missing)
        });
    };

    let installed = output_of(&resolved, &spec.version_args)
        .as_deref()
        .and_then(first_semver);

    /* 装着但不归我们管：不查最新版，也不画按钮。这里发一次网络请求只会白花时间。 */
    let Some(owner) = owner_of(&resolved) else {
        return Ok(AgentInstallStatus {
            state: AgentInstallState::External,
            installed_version: installed,
            latest_version: None,
            package_name: Some(spec.package_name),
        });
    };

    let fresh = if force {
        None
    } else {
        cached_latest(app, agent_id)
            .filter(|(_version, at)| now_ms().saturating_sub(*at) < CHECK_TTL_MS)
    };

    /* 检查时刻只服务于 TTL 判定，留在这一侧。 */
    let latest = match fresh {
        Some((version, _at)) => Some(version),
        None => match latest_version(owner, &spec.package_name) {
            Ok(version) => {
                remember_latest(app, agent_id, &version, now_ms());
                Some(version)
            }
            /* 问不到最新版是一件可以发生的事，不是一次失败：装着的那份照样能用。 */
            Err(_offline) => None,
        },
    };

    let state = match (installed.as_deref(), latest.as_deref()) {
        /* 文件在，只是它的 --version 读不懂。这不是「没装」。 */
        (None, _) | (Some(_), None) => AgentInstallState::Unknown,
        (Some(current), Some(newest)) => {
            match (
                semver::Version::parse(current),
                semver::Version::parse(newest),
            ) {
                (Ok(current), Ok(newest)) if newest > current => AgentInstallState::Outdated,
                (Ok(_), Ok(_)) => AgentInstallState::Current,
                _ => AgentInstallState::Unknown,
            }
        }
    };

    Ok(AgentInstallStatus {
        state,
        installed_version: installed,
        latest_version: latest,
        package_name: Some(spec.package_name),
    })
}

fn install(app: &AppHandle, agent_id: &str) -> Result<AgentInstallStatus> {
    let Some(spec) = agent_install_spec(app, agent_id)? else {
        return Err(Error::AgentCli(format!(
            "{agent_id} 的档案没有说这个 agent 该怎么安装"
        )));
    };

    /*
     * 已经装了就交回给装它的那一个 —— 换一个包管理器不是升级，是在另一个地方放第二份。
     * 还没装才轮到偏好顺序。
     */
    let owner = agent_program(app, agent_id)
        .ok()
        .and_then(|program| poietica_agent_runtime_native::resolve_program(&program).ok())
        .and_then(|resolved| owner_of(&resolved));

    if owner.is_none()
        && let Ok(program) = agent_program(app, agent_id)
        && poietica_agent_runtime_native::resolve_program(&program).is_ok()
    {
        return Err(Error::AgentCli(
            "这份运行时不是 bun、pnpm、npm 装的，请用你当初安装它的方式更新。".to_owned(),
        ));
    }

    let manager = owner.or_else(preferred_manager).ok_or_else(|| {
        Error::AgentCli(
            "这台电脑上没有找到 bun、pnpm 或 npm。装好其中任意一个之后重新打开 Poietica。"
                .to_owned(),
        )
    })?;

    let program = manager
        .resolved()
        .ok_or_else(|| Error::AgentCli(format!("这台电脑上没有找到 {}", manager.program())))?;

    /* 目标版本与检测同源。查不到（离线、镜像不通）才退回 latest。 */
    let target = latest_version(manager, &spec.package_name).ok();

    let mut command = Command::new(&program);
    command.args(manager.install_args(&spec.package_name, target.as_deref()));
    hide_console(&mut command);

    let output = command
        .output()
        .map_err(|error| Error::AgentCli(format!("{} 没有执行成功：{error}", manager.program())))?;

    if !output.status.success() {
        let spoken = String::from_utf8_lossy(&output.stderr);
        let reason = spoken
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .unwrap_or("包管理器没有说明原因");

        return Err(Error::AgentCli(format!("安装没有完成：{reason}")));
    }

    /* 装完那一刻缓存必然过期：强制重算，调用方拿到的就是新状态，不用再问一次。 */
    let status = compute(app, agent_id, true)?;

    /*
     * 退出码 0 不等于装到位了 —— 这一版就发生过：包管理器报成功，落地的是上一个版本。
     * 不比对的话，界面只会把同一个「更新到 X」再画一次，而一个点了没反应的按钮比一句
     * 错误难排查得多。
     */
    if let (Some(target), Some(installed)) =
        (target.as_deref(), status.installed_version.as_deref())
        && target != installed
    {
        return Err(Error::AgentCli(format!(
            "{program} 报告安装成功，但落地的是 {installed}，目标是 {target}。多半是包管理器的元数据缓存过旧，可在终端里执行：{command}",
            program = manager.program(),
            command = std::iter::once(manager.program().to_owned())
                .chain(manager.install_args(&spec.package_name, Some(target)))
                .collect::<Vec<String>>()
                .join(" "),
        )));
    }

    Ok(status)
}

/// 当前这个 agent 装了没有、是不是最新。
///
/// force 为假时命中 24 小时内的缓存就直接返回，不起网络。界面每次挂载都可以调它。
///
/// # Errors
///
/// 读不到 agent 档案时返回错误。「没装」「不归我们管」「问不到最新版」都不是错误，
/// 它们是状态。
#[command]
#[specta::specta]
pub async fn agent_install_status(
    app: AppHandle,
    agent_id: String,
    force: bool,
) -> std::result::Result<AgentInstallStatus, Problem> {
    async_runtime::spawn_blocking(move || compute(&app, &agent_id, force))
        .await
        .map_err(|error| Error::AgentCli(format!("安装状态没有查完：{error}")))?
        .map_err(Problem::from)
}

/// 安装或更新这个 agent 的运行时，完成后返回新的状态。
///
/// # Errors
///
/// 档案没有声明安装方式、这份运行时不归 pnpm/npm 管、包管理器缺席、或安装本身失败。
#[command]
#[specta::specta]
pub async fn agent_install_run(
    app: AppHandle,
    agent_id: String,
) -> std::result::Result<AgentInstallStatus, Problem> {
    async_runtime::spawn_blocking(move || install(&app, &agent_id))
        .await
        .map_err(|error| Error::AgentCli(format!("安装没有跑完：{error}")))?
        .map_err(Problem::from)
}

#[cfg(test)]
mod tests {
    use super::{PackageManager, first_semver};

    #[test]
    fn a_version_line_is_read_regardless_of_its_layout() {
        assert_eq!(first_semver("kimi-code 1.4.2").as_deref(), Some("1.4.2"));
        assert_eq!(first_semver("v2.0.0-rc.1\n").as_deref(), Some("2.0.0-rc.1"));
    }

    #[test]
    fn a_line_without_a_version_is_not_guessed() {
        assert_eq!(first_semver("command not found"), None);
    }

    #[test]
    fn each_manager_installs_globally_with_its_own_verb() {
        assert_eq!(
            PackageManager::Pnpm.install_args("pkg", Some("1.2.3")),
            vec!["add", "--global", "pkg@1.2.3"]
        );
        assert!(
            PackageManager::Npm
                .install_args("pkg", None)
                .contains(&"pkg@latest".to_owned())
        );
    }

    #[test]
    fn each_manager_asks_the_registry_in_its_own_words() {
        assert!(
            PackageManager::Bun
                .view_args("pkg")
                .contains(&"info".to_owned())
        );
        assert!(
            PackageManager::Pnpm
                .view_args("pkg")
                .contains(&"view".to_owned())
        );
    }
}
