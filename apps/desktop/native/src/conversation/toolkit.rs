use super::AgentCommandResult;
use super::dto::AgentLaunch;
use crate::agent::profile::agent_home_directory;
use poietica_conversation_runtime::toolkit::{AgentToolkit, collect_toolkit};
use serde::Deserialize;
use specta::Type;

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolkitRequest {
    pub launch: AgentLaunch,
    pub cwd: Option<String>,
    pub thread_id: Option<String>,
}

#[specta::specta]
pub async fn agent_toolkit(request: AgentToolkitRequest) -> AgentCommandResult<AgentToolkit> {
    let requested_cwd = request.cwd.clone();
    let (runtime, servers) = crate::conversation::runtime()?
        .toolkit(request.launch.agent_id, request.cwd, request.thread_id)
        .await
        .map_err(crate::error::Error::from)?;
    let root = agent_home_directory()
        .map_err(poietica_problem::Problem::from)?
        .join("skills");
    tokio::task::spawn_blocking(move || {
        collect_toolkit(&root, requested_cwd.as_deref(), runtime, servers)
    })
    .await
    .map_err(|error| poietica_problem::Problem::from(crate::Error::Internal(error.to_string())))?
    .map_err(|error| poietica_problem::Problem::from(crate::Error::Plugin(error.to_string())))
}
