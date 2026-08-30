//! agent 运行时的安装与更新。
//!
//! 这不是 `agent_cli_exec` 的放宽版，也永远不该并进去。那条管线的白名单说的是
//! 「provider 子命令」；把一次全局安装塞进那张表，等于把一个受控入口改成通用执行
//! 入口。这里是第二条同样封闭的管线：包名由 agents.json 的档案声明，程序只可能是
//! bun、pnpm、npm 三者之一，渲染层能说的只有「装哪个 agent」。
//!
//! 归属判定、最新版查询与安装执行住在 `poietica-kap-client` 的 process/install.rs
//! —— 那里的判据有自己的单测；这里只剩两样宿主的事：agents.json 里那份 24 小时
//! 的检测缓存，与「档案 → crate 调用」的编排。检测结果不轮询 —— 这是 npm
//! update-notifier 的默认间隔与 Homebrew `HOMEBREW_AUTO_UPDATE_SECS` 的同一个
//! 量级。全局 bin 目录只查一次，一次会话内不变。

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use specta::Type;
use tauri::{AppHandle, async_runtime, command};

use crate::error::{Error, Result};
use poietica_kap_client::{
    InstallState as NativeInstallState, InstallStatus as NativeInstallStatus, KapError,
    install_package, install_state_of, latest_version, owner_of, preferred_manager,
    reported_version, resolve_program,
};
use poietica_problem::Problem;

use super::profile::{agent_install_spec, agent_program, open_store};

const CHECK_KEY: &str = "installChecks";
const CHECK_TTL_MS: i64 = 24 * 60 * 60 * 1000;

/// crate 侧工具链失败原样上屏；其余按 Display 折叠。
fn surfaced(error: KapError) -> Error {
    match error {
        KapError::Toolchain { message } | KapError::Validation { message } => {
            Error::AgentCli(message)
        }
        other => Error::AgentCli(other.to_string()),
    }
}

/// 界面读到的安装处境（IPC DTO；判据在 crate 的 InstallState）。
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

impl From<NativeInstallState> for AgentInstallState {
    fn from(state: NativeInstallState) -> Self {
        match state {
            NativeInstallState::Unmanaged => Self::Unmanaged,
            NativeInstallState::Missing => Self::Missing,
            NativeInstallState::Outdated => Self::Outdated,
            NativeInstallState::Current => Self::Current,
            NativeInstallState::External => Self::External,
            NativeInstallState::Unknown => Self::Unknown,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstallStatus {
    pub state: AgentInstallState,
    pub installed_version: Option<String>,
    pub latest_version: Option<String>,
    pub package_name: Option<String>,
}

impl From<NativeInstallStatus> for AgentInstallStatus {
    fn from(status: NativeInstallStatus) -> Self {
        Self {
            state: status.state.into(),
            installed_version: status.installed_version,
            latest_version: status.latest_version,
            package_name: status.package_name,
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

fn cached_latest(app: &AppHandle, agent_id: &str) -> Option<(String, i64)> {
    let store = open_store(app).ok()?;
    let table = store.get(CHECK_KEY)?;
    let record = table.get(agent_id)?;

    Some((
        record.get("latestVersion")?.as_str()?.to_owned(),
        record.get("checkedAt")?.as_i64()?,
    ))
}

fn remember_latest(app: &AppHandle, agent_id: &str, version: &str, checked_at: i64) {
    let Ok(store) = open_store(app) else {
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
        return Ok(NativeInstallStatus::plain(NativeInstallState::Unmanaged).into());
    };

    let program = agent_program(app, agent_id)?;

    /* 解析处只有一个：kap 会话与 provider CLI 起的也是它解析出的那份。 */
    let Ok(resolved) = resolve_program(&program) else {
        return Ok(NativeInstallStatus {
            state: NativeInstallState::Missing,
            package_name: Some(spec.package_name),
            ..NativeInstallStatus::plain(NativeInstallState::Missing)
        }
        .into());
    };

    let installed = reported_version(&resolved, &spec.version_args);

    /* 装着但不归我们管：不查最新版，也不画按钮。这里发一次网络请求只会白花时间。 */
    let Some(owner) = owner_of(&resolved) else {
        return Ok(NativeInstallStatus {
            state: NativeInstallState::External,
            installed_version: installed,
            latest_version: None,
            package_name: Some(spec.package_name),
        }
        .into());
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

    let state = install_state_of(installed.as_deref(), latest.as_deref());

    Ok(NativeInstallStatus {
        state,
        installed_version: installed,
        latest_version: latest,
        package_name: Some(spec.package_name),
    }
    .into())
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
        .and_then(|program| resolve_program(&program).ok())
        .and_then(|resolved| owner_of(&resolved));

    if owner.is_none()
        && let Ok(program) = agent_program(app, agent_id)
        && resolve_program(&program).is_ok()
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

    /* 目标版本与检测同源。查不到（离线、镜像不通）才退回 latest。 */
    let target = latest_version(manager, &spec.package_name).ok();

    install_package(manager, &spec.package_name, target.as_deref()).map_err(surfaced)?;

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
