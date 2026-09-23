//! agent 接入档案与按 agent 隔离的路径；不存密钥——API key 只进 agent 受控 home 的 config.toml，本盘无副本。

use crate::error::{Error, Result};
use crate::paths::{agent_home, agents_store};
use poietica_agent_client::{
    AgentError, ProcessEnvironment, args_of as profile_args_of, declared_env_of, home_var_of,
    install_spec_of, launch_env as compose_launch_env, own_home_of, program_of, unset_env_of,
};
use poietica_problem::Problem;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Manager, Wry, command};
use tauri_plugin_store::{Store, StoreExt};

type AgentConfigCommandResult<T> = std::result::Result<T, Problem>;

const STORE_KEY: &str = "agentConfig";

/// 官方位置是 `<agent home>/mcp.json`，那个 home 由 `launch_env` 的受控变量指出来。
const MCP_CONFIG_FILE: &str = "mcp.json";

#[derive(Debug, Deserialize, Serialize, Type, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigSnapshot {
    pub agents: Vec<Value>,
    pub default_agent_id: String,
    pub issues: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct PersistedAgentConfig {
    agents: Vec<Value>,
    default_agent_id: String,
}

pub(super) fn surfaced(error: AgentError) -> Error {
    match error {
        AgentError::Toolchain { message } | AgentError::Validation { message } => {
            Error::AgentCli(message)
        }
        other => Error::AgentCli(other.to_string()),
    }
}

fn profile_of(app: &AppHandle, agent_id: &str) -> Result<Value> {
    let (config, _issues) = read_config(app)?;

    config
        .agents
        .into_iter()
        .find(|agent| agent.get("id").and_then(Value::as_str) == Some(agent_id))
        .ok_or_else(|| Error::AgentCli(format!("agents.json 里没有 {agent_id} 的接入档案")))
}

fn controlled_home(
    app: &AppHandle,
    agent_id: &str,
    profile: &Value,
) -> Result<Option<poietica_agent_client::ControlledHome>> {
    let Some(variable) = home_var_of(profile) else {
        return Ok(None);
    };

    Ok(Some(poietica_agent_client::ControlledHome {
        variable,
        path: agent_home(app, agent_id)?,
    }))
}

fn own_home(app: &AppHandle, agent_id: &str, profile: &Value) -> Result<PathBuf> {
    let directory = own_home_of(profile)
        .ok_or_else(|| Error::AgentCli(format!("{agent_id} 的档案没有说它自己把配置放在哪")))?;

    let home = app
        .path()
        .home_dir()
        .map_err(|error| Error::Internal(error.to_string()))?;

    Ok(home.join(directory))
}

pub fn agent_data_home(app: &AppHandle, agent_id: &str) -> Result<PathBuf> {
    let profile = profile_of(app, agent_id)?;

    match controlled_home(app, agent_id, &profile)? {
        Some(home) => Ok(home.path),
        None => own_home(app, agent_id, &profile),
    }
}

/// 只设非密文项：密钥由 agent 自己的 CLI 写进受控 home，从不经过启动环境；档案缺失按错误处理，否则 homeVar 设不上、受控 home 静默失效。
pub fn launch_env(app: &AppHandle, agent_id: &str) -> Result<ProcessEnvironment> {
    launch_env_inner(app, agent_id, true)
}

fn launch_env_inner(
    app: &AppHandle,
    agent_id: &str,
    controlled: bool,
) -> Result<ProcessEnvironment> {
    let profile = profile_of(app, agent_id)?;

    let home = if controlled {
        controlled_home(app, agent_id, &profile)?
    } else {
        None
    };

    Ok(compose_launch_env(
        &declared_env_of(&profile),
        home.as_ref(),
        &unset_env_of(&profile),
    ))
}

pub use poietica_agent_client::InstallSpec as AgentInstallSpec;

pub fn agent_install_spec(app: &AppHandle, agent_id: &str) -> Result<Option<AgentInstallSpec>> {
    Ok(install_spec_of(&profile_of(app, agent_id)?))
}

/// 程序名刻意不来自请求：白名单挡不住 `{ command: 任意程序 }` 这类请求，调用方须自行校验程序名。
pub fn agent_program(app: &AppHandle, agent_id: &str) -> Result<String> {
    program_of(&profile_of(app, agent_id)?)
        .ok_or_else(|| Error::AgentCli(format!("{agent_id} 的接入档案里没有可执行文件")))
}

pub fn agent_args(app: &AppHandle, agent_id: &str) -> Result<Vec<String>> {
    Ok(profile_args_of(&profile_of(app, agent_id)?))
}

pub fn agent_mcp_config(app: &AppHandle) -> Result<PathBuf> {
    Ok(agent_home_directory(app)?.join(MCP_CONFIG_FILE))
}

pub fn agent_mcp_config_for_write(app: &AppHandle) -> Result<PathBuf> {
    let agent_id = default_agent_id(app)?;
    controlled_mcp_config(app, &agent_id)?.ok_or_else(|| {
        Error::AgentCli(format!(
            "{agent_id} 没有受控 home；不会改写用户自己的 MCP 配置"
        ))
    })
}

pub(crate) fn controlled_mcp_config(app: &AppHandle, agent_id: &str) -> Result<Option<PathBuf>> {
    let profile = profile_of(app, agent_id)?;
    Ok(controlled_home(app, agent_id, &profile)?.map(|home| home.path.join(MCP_CONFIG_FILE)))
}

pub fn agent_home_directory(app: &AppHandle) -> Result<PathBuf> {
    let agent_id = default_agent_id(app)?;

    agent_data_home(app, &agent_id)
}

/// 只读用途：不应往这个家写任何东西；不受控时与受控 home 同目录，返回 None。
pub fn own_home_directory(app: &AppHandle) -> Result<Option<PathBuf>> {
    let agent_id = default_agent_id(app)?;
    let profile = profile_of(app, &agent_id)?;

    if controlled_home(app, &agent_id, &profile)?.is_none() {
        return Ok(None);
    }

    own_home(app, &agent_id, &profile).map(Some)
}

pub(crate) fn default_agent_id(app: &AppHandle) -> Result<String> {
    let (config, _issues) = read_config(app)?;

    if config.default_agent_id.is_empty() {
        return Err(Error::AgentCli("还没有选定默认 agent".to_owned()));
    }

    Ok(config.default_agent_id)
}

fn read_config(app: &AppHandle) -> Result<(PersistedAgentConfig, Vec<String>)> {
    let store = open_store(app)?;
    let mut issues = Vec::new();

    let config = match store.get(STORE_KEY) {
        None => PersistedAgentConfig::default(),
        Some(value) => match serde_json::from_value(value) {
            Ok(parsed) => parsed,
            Err(error) => {
                issues.push(format!("agents.json 格式无效：{error}"));
                PersistedAgentConfig::default()
            }
        },
    };

    Ok((config, issues))
}

fn to_snapshot(config: PersistedAgentConfig, issues: Vec<String>) -> AgentConfigSnapshot {
    AgentConfigSnapshot {
        agents: config.agents,
        default_agent_id: config.default_agent_id,
        issues,
    }
}

fn save_config(app: &AppHandle, config: &PersistedAgentConfig) -> Result<()> {
    let store = open_store(app)?;
    store.set(STORE_KEY, serde_json::to_value(config)?);
    store.save()?;
    Ok(())
}

/// 开库只经这一处：install.rs 的检测缓存表也走它读写。
pub(crate) fn open_store(app: &AppHandle) -> Result<Arc<Store<Wry>>> {
    Ok(app.store(agents_store(app)?)?)
}

#[command]
#[specta::specta]
pub async fn agent_config_get(app: AppHandle) -> AgentConfigCommandResult<AgentConfigSnapshot> {
    (|| -> Result<AgentConfigSnapshot> {
        let (config, issues) = read_config(&app)?;
        Ok(to_snapshot(config, issues))
    })()
    .map_err(Problem::from)
}

pub(crate) fn write_config_atomically(path: &Path, text: &str) -> Result<()> {
    poietica_agent_client::write_config_atomically(path, text).map_err(surfaced)
}

#[command]
#[specta::specta]
pub async fn agent_config_save_agents(
    app: AppHandle,
    agents: Vec<Value>,
    default_agent_id: String,
) -> AgentConfigCommandResult<AgentConfigSnapshot> {
    (|| -> Result<AgentConfigSnapshot> {
        let (mut config, issues) = read_config(&app)?;
        config.agents = agents;
        config.default_agent_id = default_agent_id;
        save_config(&app, &config)?;
        Ok(to_snapshot(config, issues))
    })()
    .map_err(Problem::from)
}
