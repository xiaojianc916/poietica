//! Native builtins and user edits share a serialized, compare-before-write MCP configuration owner.
use crate::{
    agent::profile::{
        agent_mcp_config, agent_mcp_config_for_write, controlled_mcp_config,
        write_config_atomically,
    },
    automation::mcp_server,
    error::{Error, Result},
};
use poietica_extension_native as extension;
use poietica_problem::Problem;
use serde::Serialize;
use specta::Type;
use std::{path::Path, sync::Mutex};

type EnvironmentCommandResult<T> = std::result::Result<T, Problem>;

#[derive(Debug, Default)]
pub(crate) struct McpConfigAccess(Mutex<()>);

/// 读—比—写这一串不能有第二个写者插进来，所以闸是进程级的，不是每条命令一份。
static ACCESS: std::sync::OnceLock<McpConfigAccess> = std::sync::OnceLock::new();

fn hold() -> Result<std::sync::MutexGuard<'static, ()>> {
    ACCESS
        .get_or_init(McpConfigAccess::default)
        .0
        .lock()
        .map_err(|_| Error::Internal("MCP configuration ownership poisoned".to_owned()))
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentFile {
    pub location: String,
    pub contents: Option<String>,
}

fn read_file(path: &Path) -> Result<Option<String>> {
    match extension::read_optional(path) {
        Ok(contents) => Ok(contents),
        Err(extension::ExtensionError::Io(cause)) => Err(Error::from(cause)),
        Err(other) => Err(Error::Internal(other.to_string())),
    }
}

pub(crate) async fn prepare_mcp(agent_id: &str) -> Result<()> {
    let agent_id = agent_id.to_owned();
    tokio::task::spawn_blocking(move || {
        let _guard = hold()?;
        let Some(path) = controlled_mcp_config(&agent_id)? else {
            return Ok(());
        };
        let before = read_file(&path)?;
        let after = mcp_server::configure(before.as_deref())?;
        if before.as_deref() != Some(after.as_str()) {
            write_config_atomically(&path, &after)?;
        }
        Ok(())
    })
    .await
    .map_err(|error| Error::Internal(error.to_string()))?
}

#[specta::specta]
pub async fn environment_mcp_config() -> EnvironmentCommandResult<EnvironmentFile> {
    tokio::task::spawn_blocking(|| -> Result<EnvironmentFile> {
        let _guard = hold()?;
        let path = agent_mcp_config()?;
        Ok(EnvironmentFile {
            location: path.to_string_lossy().into_owned(),
            contents: read_file(&path)?,
        })
    })
    .await
    .map_err(|error| Problem::from(Error::Internal(error.to_string())))?
    .map_err(Problem::from)
}

#[specta::specta]
pub async fn environment_mcp_config_write(
    expected_contents: Option<String>,
    contents: String,
) -> EnvironmentCommandResult<EnvironmentFile> {
    tokio::task::spawn_blocking(move || -> Result<EnvironmentFile> {
        let _guard = hold()?;
        let path = agent_mcp_config_for_write()?;
        if read_file(&path)? != expected_contents {
            return Err(Error::AgentCli(
                "mcp.json 已被其他操作修改；请刷新后重试".to_owned(),
            ));
        }
        let contents = mcp_server::configure(Some(&contents))?;
        write_config_atomically(&path, &contents)?;
        Ok(EnvironmentFile {
            location: path.to_string_lossy().into_owned(),
            contents: Some(contents),
        })
    })
    .await
    .map_err(|error| Problem::from(Error::Internal(error.to_string())))?
    .map_err(Problem::from)
}
