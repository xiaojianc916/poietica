//! Desktop wire conversion and platform asset preparation.
use super::AgentRuntime;
use super::attachment::keep_bytes;
use super::dto::{
    AgentAbortPromptRequest, AgentAnswerQuestionsRequest, AgentCancelRequest,
    AgentDismissQuestionsRequest, AgentPromptRequest, AgentPromptResult,
    AgentResolvePermissionRequest, AgentSteerRequest, AgentTranscriptJson,
    AgentTranscriptOpsRequest, AgentTranscriptRequest, answered, decided,
};
use super::{AgentCommandResult, NO_CONVERSATION};
use crate::asset_protocol::AssetProtocolRegistry;
use crate::error::Error;
use crate::ledger::conversation;
use poietica_conversation::identity::TurnId;
use poietica_conversation_runtime::{ConfigSelection, Prompt, SessionAction, Takeover};
use tauri::State;
use uuid::Uuid;

/// Returns the agent's submission receipt without waiting for model completion.
#[tauri::command]
#[specta::specta]
pub async fn agent_prompt(
    state: State<'_, AgentRuntime>,
    assets: State<'_, AssetProtocolRegistry>,
    request: AgentPromptRequest,
) -> AgentCommandResult<AgentPromptResult> {
    let named = request
        .thread_id
        .as_deref()
        .ok_or_else(|| Error::Validation(NO_CONVERSATION.to_owned()))?;
    let thread_id = conversation(named)?;
    let root = state.attachments().clone();
    let registry = assets.inner().clone();
    let receipt = state
        .prompt(
            Prompt {
                agent_id: request.launch.agent_id,
                cwd: request.cwd,
                takeover: Takeover::Replace,
                thread_id,
                turn: TurnId::new(Uuid::new_v4().to_string()),
                text: request.text.trim().to_owned(),
                configuration: request
                    .configuration
                    .into_iter()
                    .map(|selected| ConfigSelection {
                        id: selected.id,
                        value: selected.value,
                    })
                    .collect(),
                assets: request.assets,
                skills: request
                    .skills
                    .into_iter()
                    .map(|skill| poietica_conversation::turn::SkillSpec {
                        name: skill.name,
                        args: skill.args,
                    })
                    .collect(),
            },
            move |thread, attached| keep_bytes(root, registry, thread.to_string(), attached),
            |_| Ok(()),
            || {
                poietica_time::WallClock::now_unix_millis(
                    &poietica_time::wall_clock::SystemWallClock,
                )
            },
        )
        .await
        .map_err(Error::from)?;
    Ok(AgentPromptResult {
        session_id: receipt.session_id,
        prompt_id: receipt.prompt_id,
    })
}

#[tauri::command]
#[specta::specta]
pub fn agent_resolve_permission(
    state: State<'_, AgentRuntime>,
    request: AgentResolvePermissionRequest,
) -> AgentCommandResult<()> {
    state
        .answer_permission(&request.request_id, decided(&request))
        .map_err(Error::from)?;
    Ok(())
}
#[tauri::command]
#[specta::specta]
pub fn agent_answer_questions(
    state: State<'_, AgentRuntime>,
    request: AgentAnswerQuestionsRequest,
) -> AgentCommandResult<()> {
    let id = request.question_id.clone();
    state
        .answer_questions(&id, answered(request))
        .map_err(Error::from)?;
    Ok(())
}
#[tauri::command]
#[specta::specta]
pub fn agent_dismiss_questions(
    state: State<'_, AgentRuntime>,
    request: AgentDismissQuestionsRequest,
) -> AgentCommandResult<()> {
    state
        .dismiss_questions(&request.question_id)
        .map_err(Error::from)?;
    Ok(())
}
#[tauri::command]
#[specta::specta]
pub async fn agent_cancel(
    state: State<'_, AgentRuntime>,
    request: AgentCancelRequest,
) -> AgentCommandResult<()> {
    state
        .control_thread(&request.thread_id, SessionAction::Cancel)
        .await
        .map_err(Error::from)?;
    Ok(())
}
#[tauri::command]
#[specta::specta]
pub async fn agent_steer(
    state: State<'_, AgentRuntime>,
    request: AgentSteerRequest,
) -> AgentCommandResult<()> {
    state
        .control_thread(&request.thread_id, SessionAction::Steer(request.prompt_ids))
        .await
        .map_err(Error::from)?;
    Ok(())
}
#[tauri::command]
#[specta::specta]
pub async fn agent_abort_prompt(
    state: State<'_, AgentRuntime>,
    request: AgentAbortPromptRequest,
) -> AgentCommandResult<()> {
    state
        .control_thread(
            &request.thread_id,
            SessionAction::AbortPrompt(request.prompt_id),
        )
        .await
        .map_err(Error::from)?;
    Ok(())
}
#[tauri::command]
#[specta::specta]
pub async fn agent_shutdown(state: State<'_, AgentRuntime>) -> AgentCommandResult<()> {
    state.disconnect().await?;
    Ok(())
}
#[tauri::command]
#[specta::specta]
pub async fn agent_transcript(
    state: State<'_, AgentRuntime>,
    request: AgentTranscriptRequest,
) -> AgentCommandResult<AgentTranscriptJson> {
    let json = state
        .transcript(request.session_id, request.agent_id, request.before_turn)
        .await
        .map_err(Error::from)?;
    Ok(AgentTranscriptJson { json })
}
#[tauri::command]
#[specta::specta]
pub async fn agent_transcript_ops(
    state: State<'_, AgentRuntime>,
    request: AgentTranscriptOpsRequest,
) -> AgentCommandResult<AgentTranscriptJson> {
    let json = state
        .transcript_ops(request.session_id, request.agent_id, request.since_seq)
        .await
        .map_err(Error::from)?;
    Ok(AgentTranscriptJson { json })
}
