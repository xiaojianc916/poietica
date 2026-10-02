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
    /// 磁盘上那一份接入档案；还没写过时是 null。
    pub profile: Option<Value>,
    pub issues: Vec<String>,
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

/// 旧盘上的形状（0.4.3 及以前）：`{agents: [...], defaultAgentId}` —— 能放多家的数组，
/// 取用时按 id 挑一条。这一格现在就是档案本身，所以旧盘取第一条、顺手改写；别家条目本来就
/// 会被下一次落盘抹掉。等不再有人从 ≤0.4.3 升上来，这个读法与它的测试一起删。
fn lifted(stored: Value) -> Option<(Value, bool)> {
    if !stored.is_object() {
        return None;
    }

    if stored.get("agents").is_none() {
        return Some((stored, false));
    }

    stored
        .get("agents")
        .and_then(Value::as_array)
        .and_then(|agents| agents.first())
        .filter(|entry| entry.is_object())
        .cloned()
        .map(|profile| (profile, true))
}

fn read_profile() -> Result<(Option<Value>, Vec<String>)> {
    let store = documents()?;
    let _holding = store.exclusive();

    let Some(stored) = store.read(STORE_KEY)? else {
        return Ok((None, Vec::new()));
    };

    match lifted(stored) {
        None => Ok((
            None,
            vec!["agents.json 里的接入档案不是一份对象".to_owned()],
        )),
        Some((profile, false)) => Ok((Some(profile), Vec::new())),
        Some((profile, true)) => {
            store.write(STORE_KEY, &profile)?;
            Ok((Some(profile), Vec::new()))
        }
    }
}

fn save_profile(profile: &Value) -> Result<()> {
    documents()?.write(STORE_KEY, profile)
}

fn profile() -> Result<Value> {
    read_profile()?
        .0
        .ok_or_else(|| Error::AgentCli("agents.json 里还没有接入档案".to_owned()))
}

fn id_of(profile: &Value) -> Result<String> {
    profile
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| Error::AgentCli("agents.json 里的接入档案没有 id".to_owned()))
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

fn own_home(profile: &Value) -> Result<PathBuf> {
    let directory = own_home_of(profile)
        .ok_or_else(|| Error::AgentCli("接入档案没有说它自己把配置放在哪".to_owned()))?;

    Ok(crate::paths::home_directory()?.join(directory))
}

pub fn agent_data_home() -> Result<PathBuf> {
    let profile = profile()?;

    match controlled_home(&id_of(&profile)?, &profile)? {
        Some(home) => Ok(home.path),
        None => own_home(&profile),
    }
}

/// 只设非密文项：密钥由 agent 自己的 CLI 写进受控 home，从不经过启动环境；档案缺失按错误处理，否则 homeVar 设不上、受控 home 静默失效。
pub fn launch_env() -> Result<ProcessEnvironment> {
    let profile = profile()?;

    let home = controlled_home(&id_of(&profile)?, &profile)?;

    Ok(compose_launch_env(
        &declared_env_of(&profile),
        home.as_ref(),
        &unset_env_of(&profile),
    ))
}

/// 程序名刻意不来自请求：白名单挡不住 `{ command: 任意程序 }` 这类请求，调用方须自行校验程序名。
pub fn agent_program() -> Result<String> {
    program_of(&profile()?).ok_or_else(|| Error::AgentCli("接入档案里没有可执行文件".to_owned()))
}

/// 桥的入口文件名，与随包目录同处；随包发，用户机器上没有第二份。
pub fn agent_entry() -> Result<String> {
    entry_of(&profile()?).ok_or_else(|| Error::AgentCli("接入档案里没有桥的入口".to_owned()))
}

/// 随包发的 agent 文件所在目录；它由宿主给，原生侧不猜自己的可执行文件在哪。
pub fn bundled_directory() -> Result<PathBuf> {
    crate::paths::bundled_directory()
}

pub fn agent_args() -> Result<Vec<String>> {
    Ok(profile_args_of(&profile()?))
}

pub fn agent_mcp_config() -> Result<PathBuf> {
    Ok(agent_home_directory()?.join(MCP_CONFIG_FILE))
}

pub fn agent_mcp_config_for_write() -> Result<PathBuf> {
    let agent_id = agent_id()?;
    controlled_mcp_config()?.ok_or_else(|| {
        Error::AgentCli(format!(
            "{agent_id} 没有受控 home；不会改写用户自己的 MCP 配置"
        ))
    })
}

pub(crate) fn controlled_mcp_config() -> Result<Option<PathBuf>> {
    let profile = profile()?;
    Ok(controlled_home(&id_of(&profile)?, &profile)?.map(|home| home.path.join(MCP_CONFIG_FILE)))
}

pub fn agent_home_directory() -> Result<PathBuf> {
    agent_data_home()
}

/// 只读用途：不应往这个家写任何东西；不受控时与受控 home 同目录，返回 None。
pub fn own_home_directory() -> Result<Option<PathBuf>> {
    let profile = profile()?;

    if controlled_home(&id_of(&profile)?, &profile)?.is_none() {
        return Ok(None);
    }

    own_home(&profile).map(Some)
}

/// 唯一在册 agent 自己的标识：受控 home 的目录名，也是会话与能力那几条命令要的身份。
pub(crate) fn agent_id() -> Result<String> {
    id_of(&profile()?)
}

#[specta::specta]
pub async fn agent_config_get() -> AgentConfigCommandResult<AgentConfigSnapshot> {
    (|| -> Result<AgentConfigSnapshot> {
        let (profile, issues) = read_profile()?;
        Ok(AgentConfigSnapshot { profile, issues })
    })()
    .map_err(Problem::from)
}

pub(crate) fn write_config_atomically(path: &Path, text: &str) -> Result<()> {
    poietica_agent_client::write_config_atomically(path, text).map_err(surfaced)
}

/// 渲染层交来的是描述符投影出来的那一份档案；形状在边界上再判一次，判据只有「是对象且有 id」。
#[specta::specta]
pub async fn agent_config_save(profile: Value) -> AgentConfigCommandResult<AgentConfigSnapshot> {
    (|| -> Result<AgentConfigSnapshot> {
        if !profile.is_object() {
            return Err(Error::Validation("接入档案必须是一份对象".to_owned()));
        }

        id_of(&profile)?;
        save_profile(&profile)?;
        Ok(AgentConfigSnapshot {
            profile: Some(profile),
            issues: Vec::new(),
        })
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

    use super::lifted;

    /// 旧盘那一份数组里的第一条就是这一家的档案，别家条目丢掉（旧判读本来也会滤掉它们）。
    #[test]
    fn a_multi_agent_document_is_lifted_to_its_first_profile() {
        let profile = json!({"id": "omp", "env": {"NO_COLOR": "1"}});
        let stored = json!({
            "agents": [profile, {"id": "other"}],
            "defaultAgentId": "omp"
        });

        assert!(matches!(lifted(stored), Some((value, true)) if value == profile));
    }

    /// 现在的形状本身就是档案：不需要抬升，也不许把它包起来。
    #[test]
    fn a_single_profile_document_is_taken_as_is() {
        let profile = json!({"id": "omp", "cwd": "C:\\notes"});

        assert!(matches!(lifted(profile.clone()), Some((value, false)) if value == profile));
    }

    /// 不是对象、或 agents 不是数组：既不是档案也不是旧形状，按无效读。
    #[test]
    fn anything_that_is_not_a_profile_is_refused() {
        assert!(lifted(json!("omp")).is_none());
        assert!(lifted(json!({"agents": "omp"})).is_none());
        assert!(lifted(json!({"agents": []})).is_none());
    }

    /// 旧盘那一格整个被换成档案：抬升不是只读一次，落盘的就是新形状。
    #[test]
    fn lifting_rewrites_the_document_in_its_new_shape() {
        let directory = tempfile::tempdir().expect("test directory");
        let path = directory.path().join("agents.json");
        let profile = json!({"id": "omp", "cwd": "C:\\notes"});
        std::fs::write(
            &path,
            serde_json::to_vec(&json!({
                "agentConfig": {"agents": [profile, {"id": "other"}], "defaultAgentId": "omp"}
            }))
            .expect("test JSON"),
        )
        .expect("test file");

        let store = DocumentStore::new(path.clone());
        let read = store
            .read("agentConfig")
            .expect("our document")
            .expect("present");
        let (lifted, rewritten) = lifted(read).expect("a legacy document lifts");

        assert!(rewritten);
        assert_eq!(lifted, profile);
        store.write("agentConfig", &lifted).expect("carry it over");

        let after: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).expect("stored document"))
                .expect("stored JSON");
        assert_eq!(after["agentConfig"], profile);
    }

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
            .write("agentConfig", &json!({"id": "omp"}))
            .expect("atomic write");

        let document: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).expect("stored document"))
                .expect("stored JSON");
        assert_eq!(document["other"]["keep"], 7);
        assert_eq!(
            store
                .read("agentConfig")
                .expect("our document")
                .expect("our document is present")["id"],
            json!("omp")
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
