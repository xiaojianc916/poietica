//! agent 运行时安装的第二条封闭管线：包名由 agents.json 档案声明，渲染层只能说「装哪个 agent」；判据在 poietica-kap-client 的 process/install.rs。

use poietica_time::WallClock;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use specta::Type;
use tauri::{AppHandle, async_runtime, command};

use crate::error::{Error, Result};
use poietica_kap_client::{
    InstallState as NativeInstallState, InstallStatus as NativeInstallStatus, install_package,
    install_state_of, latest_version, owner_of, preferred_manager, reported_version,
    resolve_program,
};
use poietica_problem::Problem;

use super::profile::{agent_install_spec, agent_program, open_store, surfaced};

const CHECK_KEY: &str = "installChecks";

const CHECK_TTL_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AgentInstallState {
    Unmanaged,
    Missing,
    Outdated,
    Current,
    External,
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
    poietica_time::wall_clock::SystemWallClock.now_unix_millis()
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

    let Ok(resolved) = resolve_program(&program) else {
        return Ok(NativeInstallStatus {
            state: NativeInstallState::Missing,
            package_name: Some(spec.package_name),
            ..NativeInstallStatus::plain(NativeInstallState::Missing)
        }
        .into());
    };

    let installed = reported_version(&resolved, &spec.version_args);

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

    let latest = match fresh {
        Some((version, _at)) => Some(version),
        None => match latest_version(owner, &spec.package_name) {
            Ok(version) => {
                remember_latest(app, agent_id, &version, now_ms());
                Some(version)
            }
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

    let target = latest_version(manager, &spec.package_name).ok();

    install_package(manager, &spec.package_name, target.as_deref()).map_err(surfaced)?;

    let status = compute(app, agent_id, true)?;

    /* 包管理器可能报成功却落地旧版本（元数据缓存过旧），必须比对落地版本。 */
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
