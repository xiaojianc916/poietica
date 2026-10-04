use super::AgentCommandResult;
use super::configuration::restate;
use super::dto::{AgentConfigControl, AgentSelectConfigRequest, AgentWorkspaceRequest};
use crate::error::Error;

#[specta::specta]
pub async fn agent_set_config_option(
    request: AgentSelectConfigRequest,
) -> AgentCommandResult<Vec<AgentConfigControl>> {
    let controls = crate::conversation::runtime()?
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
#[specta::specta]
pub async fn agent_capabilities(
    request: AgentWorkspaceRequest,
) -> AgentCommandResult<Vec<AgentConfigControl>> {
    let offered = crate::conversation::runtime()?
        .configuration_for(crate::agent::profile::agent_id()?, request.cwd)
        .await
        .map_err(Error::from)?;
    Ok(offered.into_iter().map(restate).collect())
}
