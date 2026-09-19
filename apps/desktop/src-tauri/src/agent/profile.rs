//! Agent 配置：kap agent 接入档案，以及按 agent 隔离的路径。
//!
//! 这里只存接入档案，不存模型配置的权威副本——真身在各 agent 受控 home 的
//! config.toml，由 agent 自己热重载，「哪些 provider 已配好」也以它为准。
//! 这里不存密钥：API key 经 kap 的 providers REST 交进 agent 自己的 config.toml，
//! 我们的盘上没有副本。判据住在 `poietica-kap-client` 的 process/。

use crate::error::{Error, Result};
use crate::paths::{agent_home, agents_store};
use poietica_kap_client::{
    KapError, ProcessEnvironment, args_of as profile_args_of, declared_env_of, home_var_of,
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

/// MCP 服务器清单，与 config.toml 同一个家：官方位置是 `$KIMI_CODE_HOME/mcp.json`，
/// 该变量的值由 `launch_env` 设定。
const MCP_CONFIG_FILE: &str = "mcp.json";

/// 渲染层工作所依据的完整配置快照。agents 是不透明 JSON，由 TS 侧的
/// @poietica/agent-catalog 校验，Rust 侧只存取不解释。
#[derive(Debug, Deserialize, Serialize, Type, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigSnapshot {
    pub agents: Vec<Value>,
    pub default_agent_id: String,
    /// agents.json 中存在但无法反序列化的内容。界面应显示出来。
    pub issues: Vec<String>,
}

/// 落盘到 agents.json 的形状。
#[derive(Debug, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct PersistedAgentConfig {
    agents: Vec<Value>,
    default_agent_id: String,
}

/// crate 侧拒绝与工具链失败原样上屏；其余按 Display 折叠。
pub(super) fn surfaced(error: KapError) -> Error {
    match error {
        KapError::Toolchain { message } | KapError::Validation { message } => {
            Error::AgentCli(message)
        }
        other => Error::AgentCli(other.to_string()),
    }
}

/// 这个 agent 的接入档案。查找只有这一处：CLI 用哪个程序、往哪个 home 写
/// provider、会话起哪个进程，全部从这一份档案读。
fn profile_of(app: &AppHandle, agent_id: &str) -> Result<Value> {
    let (config, _issues) = read_config(app)?;

    config
        .agents
        .into_iter()
        .find(|agent| agent.get("id").and_then(Value::as_str) == Some(agent_id))
        .ok_or_else(|| Error::AgentCli(format!("agents.json 里没有 {agent_id} 的接入档案")))
}

/// 受控 home：档案声明了 homeVar 才接手——启动时把目录设给它，它读写的就是
/// 这里；没声明就不设，它去哪儿是它自己的事。判据在 crate 的 profile.rs。
fn controlled_home(
    app: &AppHandle,
    agent_id: &str,
    profile: &Value,
) -> Result<Option<poietica_kap_client::ControlledHome>> {
    let Some(variable) = home_var_of(profile) else {
        return Ok(None);
    };

    Ok(Some(poietica_kap_client::ControlledHome {
        variable,
        path: agent_home(app, agent_id)?,
    }))
}

/// 用户自己那份 home —— 命令行上用这家 agent 时它认的目录。收 profile 而不是
/// 再查一遍：同一份档案查两次，迟早查出两个答案。
fn own_home(app: &AppHandle, agent_id: &str, profile: &Value) -> Result<PathBuf> {
    let directory = own_home_of(profile)
        .ok_or_else(|| Error::AgentCli(format!("{agent_id} 的档案没有说它自己把配置放在哪")))?;

    let home = app
        .path()
        .home_dir()
        .map_err(|error| Error::Internal(error.to_string()))?;

    Ok(home.join(directory))
}

/// 这家 agent 实际会去读的那个家。config.toml、mcp.json、skills/ 都挂在它下面
/// —— 同一个进程按同一个环境变量找到的同一个目录，「家在哪」只能有一个答案。
pub fn agent_data_home(app: &AppHandle, agent_id: &str) -> Result<PathBuf> {
    let profile = profile_of(app, agent_id)?;

    match controlled_home(app, agent_id, &profile)? {
        Some(home) => Ok(home.path),
        None => own_home(app, agent_id, &profile),
    }
}

/// 启动这个 agent 的子进程时要设的环境变量，只有非密文项——密钥由 agent 自己的
/// CLI 写进受控 home 的配置文件，从不经过启动环境。档案不存在按错误处理而非
/// 「没有变量」：那样 homeVar 设不上，agent 会安静改用用户全局目录，受控 home 失效。
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

/// 档案里声明的安装方式，缺席表示不由我们管安装。判据在 crate 的 profile.rs。
pub use poietica_kap_client::InstallSpec as AgentInstallSpec;

/// 读出这个 agent 的安装声明；档案里没有 install 一格是 Ok(None)，不是错误。
pub fn agent_install_spec(app: &AppHandle, agent_id: &str) -> Result<Option<AgentInstallSpec>> {
    Ok(install_spec_of(&profile_of(app, agent_id)?))
}

/// 这个 agent 的可执行文件，与 `launch_env` 读同一份档案：两处各算一次，迟早
/// 算出两个。
///
/// 刻意不来自请求：`is_allowed` 只校验参数，白名单挡不住 `{ command: 任意程序 }`
/// 这类请求；档案要过 TS 侧的 `parseAgentProfile` 才写得进 agents.json，但绕过
/// 成本有限，调用方仍要自己校验一遍程序名。
pub fn agent_program(app: &AppHandle, agent_id: &str) -> Result<String> {
    program_of(&profile_of(app, agent_id)?)
        .ok_or_else(|| Error::AgentCli(format!("{agent_id} 的接入档案里没有可执行文件")))
}

/// 这个 agent 的启动参数，与 `agent_program` 读同一份档案：产地只有描述符，
/// 磁盘那份由 withDescriptorFields 每次启动覆盖。kimi 的 acp 子命令在这里，
/// 与 launchEnv 的实验开关是同一个决定的两半；没有 args 一格是空表，不是错误。
pub fn agent_args(app: &AppHandle, agent_id: &str) -> Result<Vec<String>> {
    Ok(profile_args_of(&profile_of(app, agent_id)?))
}

/// 默认 agent 会去读的那份 mcp.json。取默认 agent 而非「当前会话那一个」：
/// Tool 面板不挂会话，说不出会话是哪个；会话能各自选 agent 后这格要跟着走。
pub fn agent_mcp_config(app: &AppHandle) -> Result<PathBuf> {
    Ok(agent_home_directory(app)?.join(MCP_CONFIG_FILE))
}

/// 受控 home 里那份 mcp.json，写入只认它。不受控时那份是用户自己在终端里的
/// 服务器，从这里写等于替人改配置，所以拒绝；归属判断只在这里做一次。
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

/// 默认 agent 那个家的目录本身，插件仓库的位置是它的派生——官方 data-locations
/// 逐字把 plugins/installed.json 与 plugins/managed/ 列在 `$KIMI_CODE_HOME` 之下。
pub fn agent_home_directory(app: &AppHandle) -> Result<PathBuf> {
    let agent_id = default_agent_id(app)?;

    agent_data_home(app, &agent_id)
}

/// 用户自己在命令行上用这家 agent 时认的那个家，仅当受控 home 生效时才存在；
/// 不受控时两者同目录，返回 None。只读用途：没有什么该写进这个家，与
/// `launch_env` 不设全局 home 变量是同一条规矩。
pub fn own_home_directory(app: &AppHandle) -> Result<Option<PathBuf>> {
    let agent_id = default_agent_id(app)?;
    let profile = profile_of(app, &agent_id)?;

    if controlled_home(app, &agent_id, &profile)?.is_none() {
        return Ok(None);
    }

    own_home(app, &agent_id, &profile).map(Some)
}

/// 现在默认用哪一个 agent。空串当作没有：那一格缺省值就是空串，拿去查档案只会
/// 得到一句缺了名字的错误。
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

/// agents.json 那个库，开库的手只在这一文件；install.rs 的检测缓存表也经这里
/// 读写——每一次开库都从这一处出。
pub(crate) fn open_store(app: &AppHandle) -> Result<Arc<Store<Wry>>> {
    Ok(app.store(agents_store(app)?)?)
}

/// 读取完整配置快照。agents.json 缺失或损坏不算失败：返回空配置，解析问题进 issues。
#[command]
#[specta::specta]
pub async fn agent_config_get(app: AppHandle) -> AgentConfigCommandResult<AgentConfigSnapshot> {
    (|| -> Result<AgentConfigSnapshot> {
        let (config, issues) = read_config(&app)?;
        Ok(to_snapshot(config, issues))
    })()
    .map_err(Problem::from)
}

/// 原子写回一份配置；实现在 crate 的 controlled_home.rs，这里只是入口。
pub(crate) fn write_config_atomically(path: &Path, text: &str) -> Result<()> {
    poietica_kap_client::write_config_atomically(path, text).map_err(surfaced)
}

/// 替换 agent 列表与默认 agent。
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
