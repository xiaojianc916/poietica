//! Desktop wire conversion and platform asset preparation.
use super::AgentRuntime;
use super::attachment::keep_bytes;
use super::dto::{
    AgentAbortPromptRequest, AgentAnswerQuestionsRequest, AgentCancelRequest,
    AgentDeliveryModesRequest, AgentDismissQuestionsRequest, AgentPromptRequest, AgentPromptResult,
    AgentQueuedState, AgentResolvePermissionRequest, AgentSessionMediaRequest,
    AgentSessionMediaResult, AgentTranscriptJson, AgentTranscriptOpsRequest,
    AgentTranscriptRequest, AgentWithdrawnMessage, answered, decided,
};
use super::{AgentCommandResult, NO_CONVERSATION};
use crate::asset_protocol::AssetProtocolRegistry;
use crate::error::Error;
use crate::ledger::conversation;
use crate::paths;
use poietica_conversation::identity::TurnId;
use poietica_conversation_runtime::{
    ConfigSelection, DeliveryModes, Prompt, SessionAction, Takeover,
};
use tauri::{AppHandle, State};
use uuid::Uuid;

/// Returns the agent's submission receipt without waiting for model completion.
///
/// `deliverAs` 决定这句话走哪一层：`turn` 开一轮（回执带轮身份），三层插话不开轮
/// （回执只是「agent 收下了」—— 上游的 steer/followUp 都返回 void，队列归它）。
#[tauri::command]
#[specta::specta]
pub async fn agent_prompt(
    app: AppHandle,
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
    let staging_root = paths::composer_staging_root(&app)?;
    let registry = assets.inner().clone();
    let deliver_as = request.deliver_as.into();
    let receipt = state
        .prompt(
            Prompt {
                agent_id: request.launch.agent_id,
                cwd: request.cwd,
                takeover: Takeover::Replace,
                thread_id,
                turn: TurnId::new(Uuid::new_v4().to_string()),
                text: request.text.trim().to_owned(),
                deliver_as,
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
            move |_thread, attached| {
                keep_bytes(
                    root.clone(),
                    staging_root.clone(),
                    registry.clone(),
                    attached,
                )
            },
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
/// 待发队列此刻的样子。队列的真相在 agent 里，这条只是读回来。
#[tauri::command]
#[specta::specta]
pub async fn agent_queue(state: State<'_, AgentRuntime>) -> AgentCommandResult<AgentQueuedState> {
    let queue = state.queued().await.map_err(Error::from)?;
    Ok(queue.into())
}

/// 撤回最后一条还排着的插话（LIFO）；队列空着回 null，不是错。
#[tauri::command]
#[specta::specta]
pub async fn agent_withdraw(
    state: State<'_, AgentRuntime>,
) -> AgentCommandResult<Option<AgentWithdrawnMessage>> {
    let restored = state.withdraw().await.map_err(Error::from)?;
    Ok(restored.map(|message| AgentWithdrawnMessage { text: message.text }))
}

/// 改队列模式；应答是改完之后那一份队列。
#[tauri::command]
#[specta::specta]
pub async fn agent_set_delivery_modes(
    state: State<'_, AgentRuntime>,
    request: AgentDeliveryModesRequest,
) -> AgentCommandResult<AgentQueuedState> {
    let queue = state
        .set_delivery_modes(DeliveryModes {
            steering: request.steering_mode,
            follow_up: request.follow_up_mode,
            interrupt: request.interrupt_mode,
        })
        .await
        .map_err(Error::from)?;
    Ok(queue.into())
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

#[tauri::command]
#[specta::specta]
pub async fn agent_session_media(
    state: State<'_, AgentRuntime>,
    request: AgentSessionMediaRequest,
) -> AgentCommandResult<AgentSessionMediaResult> {
    let (content_type, base64) = state
        .session_media(request.session_id, request.file_id)
        .await
        .map_err(Error::from)?;
    Ok(AgentSessionMediaResult {
        content_type,
        base64,
    })
}
