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
use tauri::{AppHandle, Manager, command};

type EnvironmentCommandResult<T> = std::result::Result<T, Problem>;

#[derive(Debug, Default)]
pub(crate) struct McpConfigAccess(Mutex<()>);

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

pub(crate) async fn prepare_mcp(app: &AppHandle, agent_id: &str) -> Result<()> {
    let app = app.clone();
    let agent_id = agent_id.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let access = app.state::<McpConfigAccess>();
        let _guard = access
            .0
            .lock()
            .map_err(|_| Error::Internal("MCP configuration ownership poisoned".to_owned()))?;
        let Some(path) = controlled_mcp_config(&app, &agent_id)? else {
            return Ok(());
        };
        let before = read_file(&path)?;
        let after = mcp_server::configure(&app, before.as_deref())?;
        if before.as_deref() != Some(after.as_str()) {
            write_config_atomically(&path, &after)?;
        }
        Ok(())
    })
    .await
    .map_err(|error| Error::Internal(error.to_string()))?
}

#[command]
#[specta::specta]
pub async fn environment_mcp_config(app: AppHandle) -> EnvironmentCommandResult<EnvironmentFile> {
    tauri::async_runtime::spawn_blocking(move || -> Result<EnvironmentFile> {
        let access = app.state::<McpConfigAccess>();
        let _guard = access
            .0
            .lock()
            .map_err(|_| Error::Internal("MCP configuration ownership poisoned".to_owned()))?;
        let path = agent_mcp_config(&app)?;
        Ok(EnvironmentFile {
            location: path.to_string_lossy().into_owned(),
            contents: read_file(&path)?,
        })
    })
    .await
    .map_err(|error| Problem::from(Error::Internal(error.to_string())))?
    .map_err(Problem::from)
}

#[command]
#[specta::specta]
pub async fn environment_mcp_config_write(
    app: AppHandle,
    expected_contents: Option<String>,
    contents: String,
) -> EnvironmentCommandResult<EnvironmentFile> {
    tauri::async_runtime::spawn_blocking(move || -> Result<EnvironmentFile> {
        let access = app.state::<McpConfigAccess>();
        let _guard = access
            .0
            .lock()
            .map_err(|_| Error::Internal("MCP configuration ownership poisoned".to_owned()))?;
        let path = agent_mcp_config_for_write(&app)?;
        if read_file(&path)? != expected_contents {
            return Err(Error::AgentCli(
                "mcp.json 已被其他操作修改；请刷新后重试".to_owned(),
            ));
        }
        let contents = mcp_server::configure(&app, Some(&contents))?;
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
