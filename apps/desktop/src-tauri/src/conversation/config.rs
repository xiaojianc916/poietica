//! Wire conversion for the connection-owned configuration use case.
use crate::error::Error;
use poietica_conversation_runtime::connection::Takeover;
use poietica_kap_client::{ConfigControl, ConfigPurpose};
use tauri::State;
use super::dto::{
    AgentCapabilitiesRequest, AgentConfigChoice, AgentConfigControl, AgentConfigPurpose,
    AgentSelectConfigRequest,
};
use super::failure::translate;
use super::runtime::AgentRuntime;
use super::{AgentCommandResult, NO_ANSWER};

#[tauri::command]
#[specta::specta]
pub async fn agent_set_config_option(
    state: State<'_, AgentRuntime>,
    request: AgentSelectConfigRequest,
) -> AgentCommandResult<Vec<AgentConfigControl>> {
    let controls = state.select_configuration(
        request.thread_id, request.config_id, request.value, request.input,
    ).await.map_err(Error::from)?;
    Ok(controls.into_iter().map(restate).collect())
}

/// Reads the anchor without creating a conversation.
#[tauri::command]
#[specta::specta]
pub async fn agent_capabilities(
    state: State<'_, AgentRuntime>,
    request: AgentCapabilitiesRequest,
) -> AgentCommandResult<Vec<AgentConfigControl>> {
    let live = state.ensure(request.launch.agent_id, request.cwd, Takeover::Replace).await?;
    let answer = live.client.selectors(live.anchor).map_err(translate)?;
    let offered = answer.await
        .map_err(|_dropped| Error::Internal(NO_ANSWER.to_owned()))?
        .map_err(translate)?;
    Ok(offered.into_iter().map(restate).collect())
}

pub(super) fn restate(control: ConfigControl) -> AgentConfigControl {
    AgentConfigControl {
        id: control.id,
        label: control.label,
        detail: control.detail,
        purpose: match control.purpose {
            ConfigPurpose::Permission => AgentConfigPurpose::Permission,
            ConfigPurpose::Mode => AgentConfigPurpose::Mode,
            ConfigPurpose::Model => AgentConfigPurpose::Model,
            ConfigPurpose::Thought => AgentConfigPurpose::Thought,
            ConfigPurpose::Other => AgentConfigPurpose::Other,
        },
        applies_on_submit: control.applies_on_submit,
        current: control.current,
        choices: control
            .choices
            .into_iter()
            .map(|choice| AgentConfigChoice {
                value: choice.value,
                label: choice.label,
                detail: choice.detail,
            })
            .collect(),
    }
}
