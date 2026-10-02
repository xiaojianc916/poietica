//! agent 接入档案与按 agent 隔离的路径；不存密钥——API key 只进 agent 受控 home 的 config.toml，本盘无副本。

use crate::error::{Error, Result};
use crate::paths::{agent_home, agents_store};
use poietica_agent_client::{
    AgentError, ProcessEnvironment, args_of as profile_args_of, declared_env_of, entry_of,
    home_var_of, launch_env as compose_launch_env, own_home_of, program_of, unset_env_of,
};
use poietica_problem::Problem;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use specta::Type;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use tempfile::NamedTempFile;

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

/// 落盘的类形与 settings.json 同一条：根对象里一个键一条文档，顶层别的键原样留着。
///
/// 这是 agents.json 与 agent 自己那份 config.toml 的区别：config.toml 归 agent，
/// 我们只经它的官方写入面改；agents.json 是我们自己的账，改它就该只动我们自己那一格。
pub(crate) struct DocumentStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl DocumentStore {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
        }
    }

    /// 排他：读—改—写这一串不能有第二个写者插进来，同一条文档的两次改会互相吞掉。
    pub(crate) fn exclusive(&self) -> MutexGuard<'_, ()> {
        self.lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn entries(&self) -> Result<Map<String, Value>> {
        match std::fs::read(&self.path) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
            Err(error) => Err(Error::Io(error)),
        }
    }

    pub(crate) fn read(&self, key: &str) -> Result<Option<Value>> {
        Ok(self.entries()?.remove(key))
    }

    /// 临时文件 + 改名：半份文档不是合法状态，崩在中间只能看到上一版。
    pub(crate) fn write(&self, key: &str, value: &Value) -> Result<()> {
        let mut document = self.entries()?;
        document.insert(key.to_owned(), value.clone());
        let directory = self
            .path
            .parent()
            .ok_or_else(|| Error::Validation("agents.json has no parent directory".to_owned()))?;
        std::fs::create_dir_all(directory)?;
        let mut temporary = NamedTempFile::new_in(directory)?;
        serde_json::to_writer_pretty(&mut temporary, &document)?;
        std::io::Write::write_all(&mut temporary, b"\n")?;
        temporary.as_file().sync_all()?;
        temporary
            .persist(&self.path)
            .map_err(|failure| Error::Io(failure.error))?;

        Ok(())
    }
}

/// 档案进程里只有一份，所以这里读的是一格槽，不是一个全局表。
static STORE: Mutex<Option<std::sync::Arc<DocumentStore>>> = Mutex::new(None);

/// 接入档案与安装检查缓存共用这一份文档：同一条读—改—写串行，第二份锁就是第二个写者。
pub(crate) fn documents() -> Result<std::sync::Arc<DocumentStore>> {
    let mut held = STORE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);

    if held.is_none() {
        *held = Some(std::sync::Arc::new(DocumentStore::new(agents_store()?)));
    }

    held.clone()
        .ok_or_else(|| Error::Internal("the agent store is not open".to_owned()))
}

fn read_config() -> Result<(PersistedAgentConfig, Vec<String>)> {
    let store = documents()?;
    let _reading = store.exclusive();
    let mut issues = Vec::new();

    let config = match store.read(STORE_KEY)? {
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

fn save_config(config: &PersistedAgentConfig) -> Result<()> {
    documents()?.write(STORE_KEY, &serde_json::to_value(config)?)
}

fn profile_of(agent_id: &str) -> Result<Value> {
    let (config, _issues) = read_config()?;

    config
        .agents
        .into_iter()
        .find(|agent| agent.get("id").and_then(Value::as_str) == Some(agent_id))
        .ok_or_else(|| Error::AgentCli(format!("agents.json 里没有 {agent_id} 的接入档案")))
}

fn controlled_home(
    agent_id: &str,
    profile: &Value,
) -> Result<Option<poietica_agent_client::ControlledHome>> {
    let Some(variable) = home_var_of(profile) else {
        return Ok(None);
    };

    Ok(Some(poietica_agent_client::ControlledHome {
        variable,
        path: agent_home(agent_id)?,
    }))
}

fn own_home(agent_id: &str, profile: &Value) -> Result<PathBuf> {
    let directory = own_home_of(profile)
        .ok_or_else(|| Error::AgentCli(format!("{agent_id} 的档案没有说它自己把配置放在哪")))?;

    Ok(crate::paths::home_directory()?.join(directory))
}

pub fn agent_data_home(agent_id: &str) -> Result<PathBuf> {
    let profile = profile_of(agent_id)?;

    match controlled_home(agent_id, &profile)? {
        Some(home) => Ok(home.path),
        None => own_home(agent_id, &profile),
    }
}

/// 只设非密文项：密钥由 agent 自己的 CLI 写进受控 home，从不经过启动环境；档案缺失按错误处理，否则 homeVar 设不上、受控 home 静默失效。
pub fn launch_env(agent_id: &str) -> Result<ProcessEnvironment> {
    launch_env_inner(agent_id, true)
}

fn launch_env_inner(agent_id: &str, controlled: bool) -> Result<ProcessEnvironment> {
    let profile = profile_of(agent_id)?;

    let home = if controlled {
        controlled_home(agent_id, &profile)?
    } else {
        None
    };

    Ok(compose_launch_env(
        &declared_env_of(&profile),
        home.as_ref(),
        &unset_env_of(&profile),
    ))
}

/// 程序名刻意不来自请求：白名单挡不住 `{ command: 任意程序 }` 这类请求，调用方须自行校验程序名。
pub fn agent_program(agent_id: &str) -> Result<String> {
    program_of(&profile_of(agent_id)?)
        .ok_or_else(|| Error::AgentCli(format!("{agent_id} 的接入档案里没有可执行文件")))
}

/// 桥的入口文件名，与随包目录同处；随包发，用户机器上没有第二份。
pub fn agent_entry(agent_id: &str) -> Result<String> {
    entry_of(&profile_of(agent_id)?)
        .ok_or_else(|| Error::AgentCli(format!("{agent_id} 的接入档案里没有桥的入口")))
}

/// 随包发的 agent 文件所在目录；它由宿主给，原生侧不猜自己的可执行文件在哪。
pub fn bundled_directory() -> Result<PathBuf> {
    crate::paths::bundled_directory()
}

pub fn agent_args(agent_id: &str) -> Result<Vec<String>> {
    Ok(profile_args_of(&profile_of(agent_id)?))
}

pub fn agent_mcp_config() -> Result<PathBuf> {
    Ok(agent_home_directory()?.join(MCP_CONFIG_FILE))
}

pub fn agent_mcp_config_for_write() -> Result<PathBuf> {
    let agent_id = default_agent_id()?;
    controlled_mcp_config(&agent_id)?.ok_or_else(|| {
        Error::AgentCli(format!(
            "{agent_id} 没有受控 home；不会改写用户自己的 MCP 配置"
        ))
    })
}

pub(crate) fn controlled_mcp_config(agent_id: &str) -> Result<Option<PathBuf>> {
    let profile = profile_of(agent_id)?;
    Ok(controlled_home(agent_id, &profile)?.map(|home| home.path.join(MCP_CONFIG_FILE)))
}

pub fn agent_home_directory() -> Result<PathBuf> {
    let agent_id = default_agent_id()?;

    agent_data_home(&agent_id)
}

/// 只读用途：不应往这个家写任何东西；不受控时与受控 home 同目录，返回 None。
pub fn own_home_directory() -> Result<Option<PathBuf>> {
    let agent_id = default_agent_id()?;
    let profile = profile_of(&agent_id)?;

    if controlled_home(&agent_id, &profile)?.is_none() {
        return Ok(None);
    }

    own_home(&agent_id, &profile).map(Some)
}

pub(crate) fn default_agent_id() -> Result<String> {
    let (config, _issues) = read_config()?;

    if config.default_agent_id.is_empty() {
        return Err(Error::AgentCli("还没有选定默认 agent".to_owned()));
    }

    Ok(config.default_agent_id)
}

fn to_snapshot(config: PersistedAgentConfig, issues: Vec<String>) -> AgentConfigSnapshot {
    AgentConfigSnapshot {
        agents: config.agents,
        default_agent_id: config.default_agent_id,
        issues,
    }
}

#[specta::specta]
pub async fn agent_config_get() -> AgentConfigCommandResult<AgentConfigSnapshot> {
    (|| -> Result<AgentConfigSnapshot> {
        let (config, issues) = read_config()?;
        Ok(to_snapshot(config, issues))
    })()
    .map_err(Problem::from)
}

pub(crate) fn write_config_atomically(path: &Path, text: &str) -> Result<()> {
    poietica_agent_client::write_config_atomically(path, text).map_err(surfaced)
}

#[specta::specta]
pub async fn agent_config_save_agents(
    agents: Vec<Value>,
    default_agent_id: String,
) -> AgentConfigCommandResult<AgentConfigSnapshot> {
    (|| -> Result<AgentConfigSnapshot> {
        let (mut config, issues) = read_config()?;
        config.agents = agents;
        config.default_agent_id = default_agent_id;
        save_config(&config)?;
        Ok(to_snapshot(config, issues))
    })()
    .map_err(Problem::from)
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        clippy::indexing_slicing,
        reason = "a failing fixture or unexpected document shape must fail the test loudly"
    )]

    use super::DocumentStore;
    use serde_json::json;

    /// 顶层别人的键必须原样活着：agents.json 是我们自己的账，但同一份文件里可能有别的键。
    #[test]
    fn saving_one_document_keeps_the_other_top_level_keys() {
        let directory = tempfile::tempdir().expect("test directory");
        let path = directory.path().join("agents.json");
        std::fs::write(
            &path,
            serde_json::to_vec(&json!({"other": {"keep": 7}})).expect("test JSON"),
        )
        .expect("test file");

        let store = DocumentStore::new(path.clone());
        store
            .write("agentConfig", &json!({"agents": []}))
            .expect("atomic write");

        let document: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).expect("stored document"))
                .expect("stored JSON");
        assert_eq!(document["other"]["keep"], 7);
        assert_eq!(
            store
                .read("agentConfig")
                .expect("our document")
                .expect("our document is present")["agents"],
            json!([])
        );
    }

    /// 读不出来的文档既不默认也不覆盖：它是用户的账，损坏要报错而不是静默清空。
    #[test]
    fn a_corrupt_document_is_reported_and_never_overwritten() {
        let directory = tempfile::tempdir().expect("test directory");
        let path = directory.path().join("agents.json");
        std::fs::write(&path, b"{broken").expect("corrupt test file");

        let store = DocumentStore::new(path.clone());
        assert!(store.read("agentConfig").is_err());
        assert!(store.write("agentConfig", &json!({})).is_err());
        assert_eq!(std::fs::read(&path).expect("original bytes"), b"{broken");
    }
}
