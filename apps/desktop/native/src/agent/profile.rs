//! agent 接入档案与按 agent 隔离的路径；不存密钥——API key 只进 agent 受控 home 的 config.toml，本盘无副本。

use crate::error::{Error, Result};
use crate::paths::{agent_home, agents_store};
use poietica_agent_client::{
    AgentError, ProcessEnvironment, args_of as profile_args_of, declared_env_of, entry_of,
    home_var_of, launch_env as compose_launch_env, own_home_of, program_of, unset_env_of,
};
use poietica_problem::Problem;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

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

    pub(crate) fn read(&self, key: &str) -> Result<Option<Value>> {
        Ok(crate::json_document::read_document(&self.path)?.remove(key))
    }

    pub(crate) fn write(&self, key: &str, value: &Value) -> Result<()> {
        crate::json_document::write_document(&self.path, key, value)
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

fn read_profile() -> Result<(Option<Value>, Vec<String>)> {
    let store = documents()?;
    let _holding = store.exclusive();

    let Some(stored) = store.read(STORE_KEY)? else {
        return Ok((None, Vec::new()));
    };

    if stored.is_object() {
        return Ok((Some(stored), Vec::new()));
    }

    Ok((
        None,
        vec!["agents.json 里的接入档案不是一份对象".to_owned()],
    ))
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

fn controlled_home(profile: &Value) -> Result<Option<poietica_agent_client::ControlledHome>> {
    let Some(variable) = home_var_of(profile) else {
        return Ok(None);
    };

    let path = agent_home()?;

    move_agent_home_up(&id_of(profile)?, &path);

    Ok(Some(poietica_agent_client::ControlledHome {
        variable,
        path,
    }))
}

/// 受控 home 在旧形状里埋在 `agents/<id>/home/` 底下；现在它就是 `agents/`。
///
/// 凭据、会话、技能与插件都在这里面，是用户造不回来的东西 —— 路径换了它们得跟着上来。
/// 只搬，不删，且每一步都搬不动就跳过：同名的那一份不动（那是正在用的），搬不过去的
/// 原样留在旧处，人还能自己捡回来。整趟失败也不拦会话 —— 数据都还在盘上，路径没搬上来
/// 比起不了会话可恢复。
///
/// ponytail: 一次性迁移。那层旧目录只存在于本版之前，发过一轮之后整段删掉 ——
/// 判据是盘上再也找不到 `<home>/<id>/home/` 这种形状。
fn move_agent_home_up(agent_id: &str, home: &Path) {
    let parent = home.join(agent_id);
    let buried = parent.join("home");

    if !buried.is_dir() {
        return;
    }

    let Ok(entries) = std::fs::read_dir(&buried) else {
        tracing::warn!("could not read the old agent home at {}", buried.display());

        return;
    };

    for entry in entries.flatten() {
        let destination = home.join(entry.file_name());

        if destination.exists() {
            continue;
        }

        if let Err(error) = std::fs::rename(entry.path(), &destination) {
            tracing::warn!(
                "could not move {} out of the old agent home: {error}",
                entry.path().display()
            );
        }
    }

    if std::fs::read_dir(&buried).is_ok_and(|left| left.count() == 0) {
        /* 两层的空壳顺手收走；哪一层还有东西就停在哪一层。 */
        let _ = std::fs::remove_dir(&buried);
    }

    let _ = std::fs::remove_dir(&parent);
}

fn own_home(profile: &Value) -> Result<PathBuf> {
    let directory = own_home_of(profile)
        .ok_or_else(|| Error::AgentCli("接入档案没有说它自己把配置放在哪".to_owned()))?;

    Ok(crate::paths::home_directory()?.join(directory))
}

pub fn agent_data_home() -> Result<PathBuf> {
    let profile = profile()?;

    match controlled_home(&profile)? {
        Some(home) => Ok(home.path),
        None => own_home(&profile),
    }
}

/// 只设非密文项：密钥由 agent 自己的 CLI 写进受控 home，从不经过启动环境；档案缺失按错误处理，否则 homeVar 设不上、受控 home 静默失效。
pub fn launch_env() -> Result<ProcessEnvironment> {
    let profile = profile()?;

    let home = controlled_home(&profile)?;

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
    Ok(controlled_home(&profile)?.map(|home| home.path.join(MCP_CONFIG_FILE)))
}

pub fn agent_home_directory() -> Result<PathBuf> {
    agent_data_home()
}

/// 只读用途：不应往这个家写任何东西；不受控时与受控 home 同目录，返回 None。
pub fn own_home_directory() -> Result<Option<PathBuf>> {
    let profile = profile()?;

    if controlled_home(&profile)?.is_none() {
        return Ok(None);
    }

    own_home(&profile).map(Some)
}

/// 唯一在册 agent 自己的标识：会话与能力那几条命令要的身份。它不再是任何目录名 ——
/// 受控 home 只有一层（paths::agent_home），身份只用来对账本里的行做归属判断。
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

    use super::{DocumentStore, move_agent_home_up};
    use serde_json::json;

    /// 旧 home 在 `agents/<id>/home/` 底下：里面的东西要上来，空壳要收走，凭据不丢。
    #[test]
    fn the_old_buried_home_moves_up_and_leaves_nothing_behind() {
        let directory = tempfile::tempdir().expect("test directory");
        let home = directory.path().join("agents");
        let buried = home.join("omp").join("home");
        std::fs::create_dir_all(buried.join("sessions")).expect("old sessions");
        std::fs::create_dir_all(buried.join("plugins")).expect("old plugins");
        std::fs::write(buried.join("config.yml"), b"model: x").expect("old config");
        std::fs::write(buried.join("sessions").join("a.jsonl"), b"{}").expect("old session");

        move_agent_home_up("omp", &home);

        assert_eq!(
            std::fs::read(home.join("config.yml")).expect("config came up"),
            b"model: x"
        );
        assert!(home.join("sessions").join("a.jsonl").is_file());
        assert!(home.join("plugins").is_dir());
        assert!(!home.join("omp").exists());
    }

    /// 新 home 里已经有同名的一份时不动它：就地覆盖会把已经在用的那份换掉。
    #[test]
    fn an_entry_that_is_already_home_stays_put() {
        let directory = tempfile::tempdir().expect("test directory");
        let home = directory.path().join("agents");
        let buried = home.join("omp").join("home");
        std::fs::create_dir_all(&buried).expect("old home");
        std::fs::create_dir_all(&home).expect("new home");
        std::fs::write(home.join("config.yml"), b"new").expect("new config");
        std::fs::write(buried.join("config.yml"), b"stale").expect("old config");
        std::fs::write(buried.join("leftover"), b"x").expect("unmoved file");

        move_agent_home_up("omp", &home);

        assert_eq!(
            std::fs::read(home.join("config.yml")).expect("the resident config"),
            b"new"
        );
        /* 没有同名冲突的那一份照样上来；挡住的那一份留在原处，不删。 */
        assert_eq!(
            std::fs::read(home.join("leftover")).expect("the unblocked entry"),
            b"x"
        );
        assert_eq!(
            std::fs::read(buried.join("config.yml")).expect("the blocked entry stays"),
            b"stale"
        );
        assert!(buried.is_dir());
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
