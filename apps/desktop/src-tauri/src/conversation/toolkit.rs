use super::dto::AgentLaunch;
use super::{AgentCommandResult, AgentRuntime};
use crate::agent::profile::agent_home_directory;
use poietica_conversation_runtime::toolkit::{AgentToolkit, collect_toolkit};
use serde::Deserialize;
use specta::Type;
use tauri::{AppHandle, State, async_runtime};

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolkitRequest {
    pub launch: AgentLaunch,
    pub cwd: Option<String>,
    pub thread_id: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn agent_toolkit(
    app: AppHandle,
    state: State<'_, AgentRuntime>,
    request: AgentToolkitRequest,
) -> AgentCommandResult<AgentToolkit> {
    let requested_cwd = request.cwd.clone();
    let (runtime, servers) = state
        .toolkit(request.launch.agent_id, request.cwd, request.thread_id)
        .await
        .map_err(crate::error::Error::from)?;
    let root = agent_home_directory(&app)
        .map_err(poietica_problem::Problem::from)?
        .join("skills");
    async_runtime::spawn_blocking(move || {
        collect_toolkit(&root, requested_cwd.as_deref(), runtime, servers)
    })
    .await
    .map_err(|error| poietica_problem::Problem::from(crate::Error::Internal(error.to_string())))?
    .map_err(|error| poietica_problem::Problem::from(crate::Error::Plugin(error.to_string())))
}
