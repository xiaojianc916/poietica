//! Conversation IPC preparation; session acquisition and delivery execute in the conversation use case.

use crate::asset_protocol::AssetProtocolRegistry;
use crate::error::Error;
use crate::ledger::{LocalIndex, conversation};
use poietica_conversation::identity::TurnId;
use poietica_kap_client::{ConfigSelection, apply_configurations};
use poietica_ledger::execution::read_index;
use tauri::{AppHandle, State};
use uuid::Uuid;

use super::attachment::keep_bytes;
use super::config::announce;
use super::dto::{
    AgentAbortPromptRequest, AgentAnswerQuestionsRequest, AgentCancelRequest,
    AgentDismissQuestionsRequest, AgentPromptRequest, AgentPromptResult,
    AgentResolvePermissionRequest, AgentSteerRequest, AgentTranscriptJson,
    AgentTranscriptOpsRequest, AgentTranscriptRequest, answered, decided,
};
use super::failure::translate;
use super::runtime::{AgentRuntime, borrow, ensure_session};
use super::{AgentCommandResult, NO_CONVERSATION, NO_SESSION, NOTHING_TO_STOP};
use poietica_conversation_runtime::gateway::KapGateway;

/// 返回代理确认的提交身份，不等待模型完成。
#[tauri::command]
#[specta::specta]
pub async fn agent_prompt(
    app: AppHandle,
    state: State<'_, AgentRuntime>,
    index: State<'_, LocalIndex>,
    assets: State<'_, AssetProtocolRegistry>,
    request: AgentPromptRequest,
) -> AgentCommandResult<AgentPromptResult> {
    let text = request.text.trim().to_owned();
    let attached = request.assets;
    if text.is_empty() && attached.is_empty() {
        return Err(Error::Validation("the prompt is empty".to_owned()).into());
    }
    let named = request
        .thread_id
        .as_deref()
        .ok_or_else(|| Error::Validation(NO_CONVERSATION.to_owned()))?;
    let _validated = conversation(named)?;
    let configuration: Vec<ConfigSelection> = request
        .configuration
        .into_iter()
        .map(|selected| ConfigSelection {
            id: selected.id,
            value: selected.value,
        })
        .collect();
    let skills = request
        .skills
        .into_iter()
        .map(|skill| poietica_conversation::turn::SkillSpec {
            name: skill.name,
            args: skill.args,
        })
        .collect();
    let session = ensure_session(&app, &state, request.launch, request.cwd).await?;
    let held = state
        .sessions
        .resolve(
            &index,
            &session.client,
            &session.book,
            &session.agent_id,
            &state.root,
            named,
        )
        .await
        .map_err(Error::from)?;
    let addressed = held.session_id.clone();
    let attachments = keep_bytes(
        state.attachments.clone(),
        assets.inner().clone(),
        held.thread_id.to_string(),
        attached,
    )
    .await?;
    if !configuration.is_empty() {
        apply_configurations(
            &session.client,
            addressed.clone(),
            configuration.clone(),
            Some(text.clone()),
        )
        .await
        .map_err(translate)?;
        announce(&app, &session.client, addressed.clone()).await;
    }
    let gateway = KapGateway {
        client: session.client.clone(),
        journal: state.journal.clone(),
        attachments_root: state.attachments.clone(),
    };
    let prompt_id = poietica_conversation_runtime::submit(
        index.inner(),
        gateway,
        poietica_conversation_runtime::Submission {
            thread: held.thread_id,
            session: addressed.clone(),
            turn: TurnId::new(Uuid::new_v4().to_string()),
            text,
            model: configuration
                .iter()
                .find(|selected| selected.id == "model")
                .map(|selected| selected.value.clone())
                .unwrap_or_default(),
            attachments,
            skills,
            submitted_at_unix_millis: poietica_time::WallClock::now_unix_millis(
                &poietica_time::wall_clock::SystemWallClock,
            ),
        },
    )
    .await?
    .ok_or_else(|| Error::Internal("a fresh admission was already settled".to_owned()))?;
    drop(held);
    Ok(AgentPromptResult {
        session_id: addressed,
        prompt_id,
    })
}

/// Answers a permission request the agent is blocked on.
///
/// # Errors
///
/// Fails when the request is not outstanding, or when the agent has already
/// stopped waiting.
#[tauri::command]
#[specta::specta]
pub fn agent_resolve_permission(
    state: State<'_, AgentRuntime>,
    request: AgentResolvePermissionRequest,
) -> AgentCommandResult<()> {
    /* 桌子归连接：一个答案只可能是这条连接问出来的那个问题的答案，而
    request_id 活在 agent 自己的命名空间里 —— 没有连接就没有问题可答。 */
    let live = borrow(&state)?.ok_or_else(|| Error::NotFound(NO_SESSION.to_owned()))?;

    // Every failure here means the same thing to the interface: that answer no
    // longer applies to anything. The detail stays on this side of the wire.
    live.desk
        .answer(&request.request_id, decided(&request))
        .map_err(|error| Error::NotFound(error.to_string()))?;

    Ok(())
}

/// Answers one group of questions the agent is blocked on.
///
/// 一组一次答齐。kap 的一组最多四题，问是一起问的，答也一起答 —— 逐题各发一次，
/// agent 会在中间那些时刻看到一组只答了一半的题。
///
/// 合不合这一组题由桌子判：被问的那一组题在它手上，不在这一侧。
///
/// # Errors
///
/// Fails when there is no live connection, when that group is not outstanding,
/// when an answer names a question or an option that was never asked, when a
/// single-choice question is answered with several options, or when the agent
/// has already stopped waiting.
#[tauri::command]
#[specta::specta]
pub fn agent_answer_questions(
    state: State<'_, AgentRuntime>,
    request: AgentAnswerQuestionsRequest,
) -> AgentCommandResult<()> {
    /* 桌子归连接，与回答审批同一条规矩：question_id 活在 agent 自己的命名空间
    里，没有连接就没有题可答。 */
    let live = borrow(&state)?.ok_or_else(|| Error::NotFound(NO_SESSION.to_owned()))?;

    let question_id = request.question_id.clone();

    live.questions
        .answer(&question_id, answered(request))
        .map_err(|error| Error::NotFound(error.to_string()))?;

    Ok(())
}

/// Takes one group of questions off the desk without answering it.
///
/// 与「每一题都选跳过」不是一件事：跳过是五种答复之一，agent 收到的仍是一组答案；
/// 撤下是这一组作罢，走 kap 自己的 :dismiss 后缀。两件事对 agent 的意义不同，所以
/// 它们不共用一条命令。
///
/// # Errors
///
/// Fails when there is no live connection, when that group is not outstanding,
/// or when the agent has already stopped waiting.
#[tauri::command]
#[specta::specta]
pub fn agent_dismiss_questions(
    state: State<'_, AgentRuntime>,
    request: AgentDismissQuestionsRequest,
) -> AgentCommandResult<()> {
    let live = borrow(&state)?.ok_or_else(|| Error::NotFound(NO_SESSION.to_owned()))?;

    live.questions
        .dismiss(&request.question_id)
        .map_err(|error| Error::NotFound(error.to_string()))?;

    Ok(())
}

/// Asks the agent to stop the turn running on one conversation.
///
/// 取消点名一条对话。kap 的取消是发给一条会话的一帧 abort（ws-control.ts），而一条对话持有一条会话 ——
/// 这条对应关系在打开这条对话时就写进了库（`attach_session`），提问走的也是它。
///
/// 只读寻址，不惊动 agent。查不到就是没有什么可停的 —— 走 `SessionResolver::resolve` 会为一条
/// 还没开过口的对话新开一个会话，那是纯副作用。
///
/// 它是 async 的，因为寻址经独立 reader actor；等待不占用主线程。
///
/// Cancellation is cooperative: the agent may still finish normally, and the
/// recorded stop reason reports which of the two happened.
///
/// # Errors
///
/// Fails when that conversation holds no live session, when no session is
/// running, or when the driver has stopped.
#[tauri::command]
#[specta::specta]
pub async fn agent_cancel(
    state: State<'_, AgentRuntime>,
    index: State<'_, LocalIndex>,
    request: AgentCancelRequest,
) -> AgentCommandResult<()> {
    let live = borrow(&state)?.ok_or_else(|| Error::NotFound(NO_SESSION.to_owned()))?;
    let addressed =
        held_session(&index, &request.thread_id, &live.agent_id, NOTHING_TO_STOP).await?;

    // KAP owns turn activity; a local recorder cannot gate cancellation.
    live.client.cancel(addressed).await.map_err(translate)?;

    Ok(())
}

/// 这条对话此刻握着的会话号。
///
/// 持有者对不上就不给：会话号活在各自 agent 的命名空间里，把 A 的号发给 B，
/// 动的可能是 B 的东西。与 SessionResolver::resolve 和 agent_delete_thread 同一条规矩。
async fn held_session(
    index: &State<'_, LocalIndex>,
    thread_id: &str,
    agent_id: &str,
    missing: &str,
) -> AgentCommandResult<String> {
    let id = conversation(thread_id)?;
    let stored = read_index(index, move |store| store.thread(id).map_err(Error::from)).await?;

    stored
        .and_then(|thread| {
            let owner = thread.agent_id;

            thread
                .session_id
                .filter(|_| owner.as_deref() == Some(agent_id))
        })
        .ok_or_else(|| Error::NotFound(missing.to_owned()).into())
}

/// Merges queued prompts into the turn already running on one conversation.
///
/// 队列归 kap，号由 prompt.queued 带来，本机不留副本。与取消不同：这不中断在跑
/// 的那一轮，只把这几句话并进它的上下文。
///
/// # Errors
///
/// Fails when that conversation holds no live session, or when kap says those
/// prompts are no longer queued.
#[tauri::command]
#[specta::specta]
pub async fn agent_steer(
    state: State<'_, AgentRuntime>,
    index: State<'_, LocalIndex>,
    request: AgentSteerRequest,
) -> AgentCommandResult<()> {
    let live = borrow(&state)?.ok_or_else(|| Error::NotFound(NO_SESSION.to_owned()))?;
    let addressed = held_session(&index, &request.thread_id, &live.agent_id, NO_SESSION).await?;

    live.client
        .steer(addressed, request.prompt_ids)
        .await
        .map_err(translate)?;

    Ok(())
}

/// Drops one queued prompt without touching the running turn.
///
/// # Errors
///
/// Fails when that conversation holds no live session, or when kap no longer has
/// that prompt.
#[tauri::command]
#[specta::specta]
pub async fn agent_abort_prompt(
    state: State<'_, AgentRuntime>,
    index: State<'_, LocalIndex>,
    request: AgentAbortPromptRequest,
) -> AgentCommandResult<()> {
    let live = borrow(&state)?.ok_or_else(|| Error::NotFound(NO_SESSION.to_owned()))?;
    let addressed = held_session(&index, &request.thread_id, &live.agent_id, NO_SESSION).await?;

    live.client
        .abort_prompt(addressed, request.prompt_id)
        .await
        .map_err(translate)?;

    Ok(())
}

/// Ends the session and lets the agent process exit.
///
/// # Errors
///
/// 它是 async 的，与 agent_cancel 同一条理由：收尸要等进程真的退场、还要收一次
/// 帧日志的账，而同步命令跑在主线程上，那段时间窗口会停止应答。
///
/// # Errors
///
/// Fails when the session lock was poisoned, or when the frame journal could not
/// be flushed.
#[tauri::command]
#[specta::specta]
pub async fn agent_shutdown(state: State<'_, AgentRuntime>) -> AgentCommandResult<()> {
    state.disconnect()?;

    Ok(())
}

/// 一个 agent 的 transcript 页，原样 JSON 文本。
///
/// 载荷的契约钉在 vendored @poietica/transcript 的 schema，校验在渲染层
/// （native-bridge 的 transcript 端口）—— 这一层不重抄第二份形状。
///
/// # Errors
///
/// Fails when no agent session is running or the agent refuses the read.
#[tauri::command]
#[specta::specta]
pub async fn agent_transcript(
    state: State<'_, AgentRuntime>,
    request: AgentTranscriptRequest,
) -> AgentCommandResult<AgentTranscriptJson> {
    let live = borrow(&state)?.ok_or_else(|| Error::NotFound(NO_SESSION.to_owned()))?;

    let json = live
        .client
        .read_transcript(request.session_id, request.agent_id, request.before_turn)
        .await
        .map_err(translate)?;

    Ok(AgentTranscriptJson {
        json: json.to_string(),
    })
}

/// 一个 agent 的 transcript 追赶批次，原样 JSON 文本。
///
/// # Errors
///
/// Fails when no agent session is running or the agent refuses the read.
#[tauri::command]
#[specta::specta]
pub async fn agent_transcript_ops(
    state: State<'_, AgentRuntime>,
    request: AgentTranscriptOpsRequest,
) -> AgentCommandResult<AgentTranscriptJson> {
    let live = borrow(&state)?.ok_or_else(|| Error::NotFound(NO_SESSION.to_owned()))?;

    let json = live
        .client
        .catch_up_transcript(request.session_id, request.agent_id, request.since_seq)
        .await
        .map_err(translate)?;

    Ok(AgentTranscriptJson {
        json: json.to_string(),
    })
}
