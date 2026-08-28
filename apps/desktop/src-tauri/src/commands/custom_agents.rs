use std::path::PathBuf;

use poietica_agent_runtime_native::{
    CustomAgentCatalog as NativeCatalog, CustomAgentFile as NativeFile, CustomAgentFileError,
    delete_custom_agent, list_custom_agents, save_custom_agent,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, command};

use crate::commands::agent_setup::profile::agent_home_directory;
use crate::error::{Error, Result};
use poietica_problem::Problem;

type CommandResult<T> = std::result::Result<T, Problem>;
const AGENTS_DIRECTORY: &str = "agents";

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CustomAgentFile {
    pub relative_path: String,
    pub absolute_path: String,
    pub document: String,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CustomAgentCatalog {
    pub files: Vec<CustomAgentFile>,
    pub issues: Vec<String>,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CustomAgentSaveRequest {
    pub relative_path: String,
    pub document: String,
    pub expected_document: Option<String>,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CustomAgentRemoveRequest {
    pub relative_path: String,
    pub expected_document: String,
}

#[command]
#[specta::specta]
pub async fn custom_agents_list(app: AppHandle) -> CommandResult<CustomAgentCatalog> {
    (|| -> Result<CustomAgentCatalog> {
        let root = agents_root(&app)?;
        Ok(from_native_catalog(
            list_custom_agents(&root).map_err(map_error)?,
        ))
    })()
    .map_err(Problem::from)
}

#[command]
#[specta::specta]
pub async fn custom_agents_save(
    app: AppHandle,
    request: CustomAgentSaveRequest,
) -> CommandResult<CustomAgentFile> {
    (|| -> Result<CustomAgentFile> {
        let root = agents_root(&app)?;
        let saved = save_custom_agent(
            &root,
            &request.relative_path,
            &request.document,
            request.expected_document.as_deref(),
        )
        .map_err(map_error)?;
        Ok(from_native_file(saved))
    })()
    .map_err(Problem::from)
}

#[command]
#[specta::specta]
pub async fn custom_agents_remove(
    app: AppHandle,
    request: CustomAgentRemoveRequest,
) -> CommandResult<()> {
    (|| -> Result<()> {
        let root = agents_root(&app)?;
        delete_custom_agent(&root, &request.relative_path, &request.expected_document)
            .map_err(map_error)
    })()
    .map_err(Problem::from)
}

fn agents_root(app: &AppHandle) -> Result<PathBuf> {
    Ok(agent_home_directory(app)?.join(AGENTS_DIRECTORY))
}

fn from_native_catalog(catalog: NativeCatalog) -> CustomAgentCatalog {
    CustomAgentCatalog {
        files: catalog.files.into_iter().map(from_native_file).collect(),
        issues: catalog.issues,
    }
}

fn from_native_file(file: NativeFile) -> CustomAgentFile {
    CustomAgentFile {
        relative_path: file.relative_path,
        absolute_path: file.absolute_path.to_string_lossy().into_owned(),
        document: file.document,
    }
}

fn map_error(error: CustomAgentFileError) -> Error {
    match error {
        CustomAgentFileError::Invalid(message) => Error::Validation(message),
        CustomAgentFileError::Io(error) => Error::Io(error),
        CustomAgentFileError::Conflict => {
            Error::Persistence("Agent 文件已被其他窗口修改，请刷新后再试".to_owned())
        }
    }
}
