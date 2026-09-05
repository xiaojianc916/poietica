//! Agent 配置：kap agent 接入档案，以及按 agent 隔离的凭据。
//!
//! 模式 B（受控 home）下，模型与 provider 的真身在各 agent 自己的配置文件里
//! （Kimi Code 是 `KIMI_CODE_HOME` 下的 config.toml），由 agent 自己 watch 并热
//! 重载。这里存的是 Poietica 侧的接入档案与投影源，不是模型配置的权威副本。
//!
//! 这里不存密钥，一份都不存。
//!
//! API key 的整个生命是一次投递：界面拿到用户输入，经 kap 的 providers REST
//! （`agent_model_catalog`）交给 agent 进程，它写进自己 config.toml 的
//! `[providers.<id>].api_key` —— 明文。此后 agent 只读那个文件。
//!
//! 所以钥匙串在这条链上保护不了任何东西：下游是一个明文文件，能读它的人不需要
//! 撬钥匙串。曾经存过一份，账户名是「agent:{id}:{var}」，那份副本换来的只有
//! 「不用重新输一次 key」，代价是写入、清除、跨代迁移三条命令和两代账户名。
//!
//! 上游自己的范式也是一次性的：`KIMI_REGISTRY_API_KEY=...` kimi provider add ...
//! 「哪些 provider 已配好」的权威因此是 agent，问它的 provider list，不是问
//! 我们。
//!
//! 档案字段的判读、npm 包名闸门、config.toml 的读与写住在 `poietica-kap-client`
//! 的 process/（profile.rs、controlled_home.rs）—— 那里的判据有自己的单测；这里
//! 只剩三样宿主的事：开 agents.json 那个 store、按磁盘布局算路径、DTO 互转。

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

/// MCP 服务器清单。与 config.toml 同一个家：官方文档给的位置是
/// `$KIMI_CODE_HOME/mcp.json`，而那个变量的值由 `launch_env` 设定。
const MCP_CONFIG_FILE: &str = "mcp.json";

/// 渲染层工作所依据的完整配置快照。
///
/// agents 是不透明 JSON，由 TS 侧的 @poietica/agent-catalog 校验；Rust 侧
/// 只负责存取，不解释任何字段。
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
fn surfaced(error: KapError) -> Error {
    match error {
        KapError::Toolchain { message } | KapError::Validation { message } => {
            Error::AgentCli(message)
        }
        other => Error::AgentCli(other.to_string()),
    }
}

/// 这个 agent 的接入档案。
///
/// 查找只有这一处：CLI 用哪个程序、往哪个 home 写 provider、会话起哪个进程，
/// 全部从这一份档案读。
///
/// # Errors
///
/// store 无法打开或档案不存在时返回错误。
fn profile_of(app: &AppHandle, agent_id: &str) -> Result<Value> {
    let (config, _issues) = read_config(app)?;

    config
        .agents
        .into_iter()
        .find(|agent| agent.get("id").and_then(Value::as_str) == Some(agent_id))
        .ok_or_else(|| Error::AgentCli(format!("agents.json 里没有 {agent_id} 的接入档案")))
}

/// 受控 home：这家 agent 的配置文件在我们手上时，它在哪、认哪个变量名。
///
/// 判据只有一条：档案里声明了 homeVar。声明了，启动时我们就把这个目录设给它，
/// 它读写的就是这里；没声明，那个变量我们不设，它去哪儿是它自己的事。
/// 判据与算式都在 crate 的 profile.rs，这里只是接线。
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

/// 用户自己那份 home —— 他在命令行上用这家 agent 时，它认的那个目录。
///
/// 收 profile 而不是自己再查一次：同一次调用里查两遍同一份档案，迟早查出两个答案。
///
/// # Errors
///
/// 档案没说这家把配置放在哪、或用户 home 算不出来时返回错误。
fn own_home(app: &AppHandle, agent_id: &str, profile: &Value) -> Result<PathBuf> {
    let directory = own_home_of(profile)
        .ok_or_else(|| Error::AgentCli(format!("{agent_id} 的档案没有说它自己把配置放在哪")))?;

    let home = app
        .path()
        .home_dir()
        .map_err(|error| Error::Internal(error.to_string()))?;

    Ok(home.join(directory))
}

/// 这家 agent 实际会去读的那个家。
///
/// config.toml、mcp.json、skills/ 都挂在它下面 —— 它们是同一个进程按同一个环境变量
/// 找到的同一个目录，所以「家在哪」在这个仓里只能有一个答案。
///
/// # Errors
///
/// 档案不存在、档案没说这家把配置放在哪、或用户 home 算不出来时返回错误。
pub fn agent_data_home(app: &AppHandle, agent_id: &str) -> Result<PathBuf> {
    let profile = profile_of(app, agent_id)?;

    match controlled_home(app, agent_id, &profile)? {
        Some(home) => Ok(home.path),
        None => own_home(app, agent_id, &profile),
    }
}

/// 启动这个 agent 的子进程时要设的环境变量。
///
/// 只有非密文的启动变量。密钥不在这里：模式 B 下它们由 agent 自己的 CLI 写
/// 进受控 home 里的配置文件，从不经过启动环境。
///
/// 档案不存在不再当作「没有变量要设」。
///
/// 那样 homeVar 就不会被设上，agent 会安静地改用用户全局的 ~/.kimi-code，而受控
/// home 是模式 B 的地基：provider 写到哪个 config.toml、CLI 与 kap 会话看不看得见
/// 同一份配置，全靠它。
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

/// 档案里声明的安装方式。缺席表示这个 agent 不由我们管安装。
///
/// 判据与包名闸门在 crate 的 profile.rs（`install_spec_of`）。
pub use poietica_kap_client::InstallSpec as AgentInstallSpec;

/// 读出这个 agent 的安装声明。
///
/// # Errors
///
/// 读不到档案时返回错误。档案里没有 install 一格不是错误，是 Ok(None)。
pub fn agent_install_spec(app: &AppHandle, agent_id: &str) -> Result<Option<AgentInstallSpec>> {
    Ok(install_spec_of(&profile_of(app, agent_id)?))
}

/// 这个 agent 的可执行文件。
///
/// 与 `launch_env` 读同一份档案。CLI 用哪个程序、往哪个 home 写 provider，
/// 必须与 kap 会话起来的那个进程一致；两处各算一次，迟早算出两个。
///
/// 它刻意不来自请求。渲染层报一个程序路径过来，而 `is_allowed` 只校验参数，
/// 于是白名单挡不住 `{ command: 任意程序, args: ["provider", "list"] }`。档案
/// 要先过 TS 侧的 `parseAcpAgentProfile` 才写得进 agents.json，绕过这里的成本
/// 因此高得多 —— 但也仅此而已，所以调用方仍要自己校验一遍程序名。
///
/// # Errors
///
/// 当 `agent_id` 对应的配置缺失、无法读取，或其中没有可解析的程序路径时返回错误。
pub fn agent_program(app: &AppHandle, agent_id: &str) -> Result<String> {
    program_of(&profile_of(app, agent_id)?)
        .ok_or_else(|| Error::AgentCli(format!("{agent_id} 的接入档案里没有可执行文件")))
}

/// 这个 agent 的启动参数。
///
/// 与 `agent_program` 读同一份档案、同一条规矩：产地只有描述符，磁盘上那份由
/// withDescriptorFields 每次启动无条件覆盖。
///
/// kimi 的 acp 子命令就在这里，它与 launchEnv 里那个实验开关是同一个决定的两半 ——
/// 少一半，commander 的回答是 unknown command。
///
/// # Errors
///
/// 读不到档案时返回错误。档案里没有 args 一格不是错误，是空表。
pub fn agent_args(app: &AppHandle, agent_id: &str) -> Result<Vec<String>> {
    Ok(profile_args_of(&profile_of(app, agent_id)?))
}

/// 默认 agent 会去读的那份 mcp.json。
///
/// 取默认 agent，而不是「当前会话那一个」：Tool 面板不挂在任何一条会话上，说不出
/// 会话是哪个。等会话能各自选 agent 时，这一格要跟着会话走。
///
/// # Errors
///
/// 没有默认 agent、档案不存在、或家目录算不出来时返回错误。
pub fn agent_mcp_config(app: &AppHandle) -> Result<PathBuf> {
    Ok(agent_home_directory(app)?.join(MCP_CONFIG_FILE))
}

/// 受控 home 里那份 mcp.json —— 写入只认它。
///
/// 判据与 `controlled_home` 同一条：受控 home 生效时，这个目录本来就在本应用
/// 的数据根之下（paths.rs 的 agent_home），终端里的 CLI 读的是它自己的家，两边互不
/// 相扰；不受控时那份 mcp.json 是用户在终端里的那套服务器，从这里写等于替人改配置，
/// 所以拒绝 —— 归属判断只在这里做一次，界面与领域层都不猜路径。
///
/// # Errors
///
/// 没有默认 agent、档案不存在、或这家 agent 不受控时返回错误。
pub fn agent_mcp_config_for_write(app: &AppHandle) -> Result<PathBuf> {
    let agent_id = default_agent_id(app)?;
    let profile = profile_of(app, &agent_id)?;

    match controlled_home(app, &agent_id, &profile)? {
        Some(home) => Ok(home.path.join(MCP_CONFIG_FILE)),
        None => Err(Error::AgentCli(format!(
            "{agent_id} 的 mcp.json 不归 Poietica 管：它的档案没有声明受控 home 的变量名，写下去它也不会读"
        ))),
    }
}

/// 默认 agent 那个家的目录本身。
///
/// config.toml、mcp.json、skills/、plugins/ 都挂在它下面。插件仓库的位置因此不是
/// 一条新的路径，是这一条的派生 —— 官方 data-locations 逐字把 plugins/installed.json
/// 与 plugins/managed/ 列在 `$KIMI_CODE_HOME` 之下。
///
/// # Errors
///
/// 没有默认 agent、档案不存在、或家目录算不出来时返回错误。
pub fn agent_home_directory(app: &AppHandle) -> Result<PathBuf> {
    let agent_id = default_agent_id(app)?;

    agent_data_home(app, &agent_id)
}

/// 用户自己在命令行上用这家 agent 时，它认的那个家 —— 仅当受控 home 生效时才存在。
///
/// 受控 home 一旦生效（`launch_env` 把 homeVar 设成 `agent_home`），我们启动的那个
/// 进程只会去读受控 home；用户在终端里跑同一个 CLI 时读的是这一个。两个目录各有一份
/// plugins/installed.json，而只有前者参与我们开出去的会话。
///
/// 不受控时两者是同一个目录，返回 None：同一个文件没有「另一份」。
///
/// 只读用途。没有什么该写进这个家 —— 与 `launch_env` 不设全局 home 变量是同一条规矩。
///
/// # Errors
///
/// 没有默认 agent、档案不存在、档案没说这家把配置放在哪、或用户 home 算不出来时返回错误。
pub fn own_home_directory(app: &AppHandle) -> Result<Option<PathBuf>> {
    let agent_id = default_agent_id(app)?;
    let profile = profile_of(app, &agent_id)?;

    if controlled_home(app, &agent_id, &profile)?.is_none() {
        return Ok(None);
    }

    own_home(app, &agent_id, &profile).map(Some)
}

/// 现在默认用哪一个 agent。
///
/// 空串当作没有：agents.json 里那一格的缺省值就是空串，拿它去查档案只会得到一句
/// 「agents.json 里没有  的接入档案」。
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

/// agents.json 那个库。组合根已在启动时打开它；开库的手只在这一文件。
///
/// 安装检测的缓存表（installChecks 键）也住在这个文件里，由 install.rs 经这里
/// 读写 —— agents.json 的每一次开库都从这一处出。
pub(crate) fn open_store(app: &AppHandle) -> Result<Arc<Store<Wry>>> {
    Ok(app.store(agents_store(app)?)?)
}

/// 读取完整配置快照。
///
/// agents.json 缺失或损坏都不算失败：返回空配置，把解析问题放进 issues。
///
/// # Errors
///
/// 仅当 store 插件无法打开时返回错误。
#[command]
#[specta::specta]
pub async fn agent_config_get(app: AppHandle) -> AgentConfigCommandResult<AgentConfigSnapshot> {
    (|| -> Result<AgentConfigSnapshot> {
        let (config, issues) = read_config(&app)?;
        Ok(to_snapshot(config, issues))
    })()
    .map_err(Problem::from)
}

/// 原子写回一份配置。判据与实现在 crate 的 controlled_home.rs，这里只是入口
/// （environment.rs 的 mcp.json 落盘走同一条路）。
///
/// # Errors
///
/// 临时文件建不出、写不进、落不了盘，或 rename 失败时返回错误。
pub(crate) fn write_config_atomically(path: &Path, text: &str) -> Result<()> {
    poietica_kap_client::write_config_atomically(path, text).map_err(surfaced)
}

/// 替换 agent 列表与默认 agent。
///
/// # Errors
///
/// store 无法写入时返回错误。
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
