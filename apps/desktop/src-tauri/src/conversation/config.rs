use super::configuration::restate;
use super::dto::{AgentCapabilitiesRequest, AgentConfigControl, AgentSelectConfigRequest};
use super::{AgentCommandResult, AgentRuntime};
use crate::error::Error;
use tauri::State;

#[tauri::command]
#[specta::specta]
pub async fn agent_set_config_option(
    state: State<'_, AgentRuntime>,
    request: AgentSelectConfigRequest,
) -> AgentCommandResult<Vec<AgentConfigControl>> {
    let controls = state
        .select_configuration(
            request.thread_id,
            request.config_id,
            request.value,
            request.input,
        )
        .await
        .map_err(Error::from)?;
    Ok(controls.into_iter().map(restate).collect())
}

/// Reads the anchor without creating a conversation.
#[tauri::command]
#[specta::specta]
pub async fn agent_capabilities(
    state: State<'_, AgentRuntime>,
    request: AgentCapabilitiesRequest,
) -> AgentCommandResult<Vec<AgentConfigControl>> {
    let offered = state
        .configuration_for(request.launch.agent_id, request.cwd)
        .await
        .map_err(Error::from)?;
    Ok(offered.into_iter().map(restate).collect())
}
