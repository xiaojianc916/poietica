//! 一个轮次：发起、停止、回答权限、收摊。
//!
//! 帧不逐条发给界面 —— 攒一拍再交货，否则渲染进程被事件淹掉。
//! 发起走领域管线：准入（冻结意图 + 欠一次投递）→ 网关投递 → 终局记账，
//! 三步全在 command.rs 的 Conversation 里，这里只成形参数与安排收尾。

use crate::asset_protocol::AssetProtocolRegistry;
use crate::error::Error;
use crate::local_index::{LocalIndex, conversation, on_index, persistence};
use poietica_conversation::command::Conversation;
use poietica_conversation::identity::{ThreadId, TurnId};
use poietica_conversation::ports::{ConversationLedger, PromptDelivery};
use poietica_conversation::turn::admission::Admission;
use poietica_kap_client::{ConfigSelection, apply_configurations};
use tauri::{AppHandle, Manager, State, async_runtime};
use uuid::Uuid;

use super::addressing::session_for;
use super::attachment::keep_bytes;
use super::config::announce;
use super::dto::{
    AgentAbortPromptRequest, AgentAnswerQuestionsRequest, AgentCancelRequest,
    AgentDismissQuestionsRequest, AgentPromptRequest, AgentPromptResult,
    AgentResolvePermissionRequest, AgentSteerRequest, answered, decided,
};
use super::failure::translate;
use super::gateway::{KapGateway, attachment_reference};
use super::runtime::{AgentRuntime, borrow, ensure_session};
use super::{
    AgentCommandResult, IMAGE_OPENER, NO_CONVERSATION, NO_SESSION, NOTHING_TO_STOP, TITLE_CHARS,
};

/// Starts a turn and returns as soon as it is under way.
///
/// The answer to the prompt is not awaited here. Frames arrive on
/// [`AGENT_EVENT`] as they are recorded, which is what the timeline consumes;
/// blocking the caller until the agent stopped would defeat the point.
///
/// # Errors
///
/// Fails when the prompt is empty, the agent cannot be started, or the
/// conversation's name cannot be written.
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
    let configuration: Vec<ConfigSelection> = request
        .configuration
        .into_iter()
        .map(|selected| ConfigSelection {
            id: selected.id,
            value: selected.value,
        })
        .collect();
    let attached = request.assets;
    let skills = request
        .skills
        .into_iter()
        .map(|skill| poietica_conversation::turn::SkillSpec {
            name: skill.name,
            args: skill.args,
        })
        .collect();

    /* 空的是这一句话，不是这一格。只挑了图、没打字，仍然是一句完整的话。 */
    if text.is_empty() && attached.is_empty() {
        return Err(Error::Validation("the prompt is empty".to_owned()).into());
    }

    /* 这里不再验类型、不再验大小。字节进注册表的那一刻就已经验过：内容类型
    由文件头嗅出来（asset.rs 的 sniff，不看扩展名），交付得了才收得下
    （validate_content_type），单张上限由 MAX_ASSET_BYTES 卡。同一件事只判一次，
    而且判在字节所在的那一侧。

    这一路唯一还会失败的事，是那两个令牌指不到东西，由 keep_bytes 说出来。 */

    let session = ensure_session(&app, &state, request.launch, request.cwd).await?;

    // 一条对话持有一个会话，这一轮就发往它。命名的对话若还没有会话，就在
    // 这里为它开一个并记下来 —— 这是 kap 的会话模型。
    let named = request
        .thread_id
        .as_deref()
        .ok_or_else(|| Error::Validation(NO_CONVERSATION.to_owned()))?;

    let held = session_for(&state, &index, &session, named).await?;
    let thread_id = held.thread_id;
    let addressed = held.session_id;

    if !configuration.is_empty() {
        apply_configurations(
            &session.client,
            addressed.clone(),
            configuration.clone(),
            Some(text.clone()),
        )
        .await
        .map_err(translate)?;

        /* 这一次提交可能立起了新目标：由 agent 报一次，屏幕不猜。 */
        announce(&app, &session.client, addressed.clone()).await;
    }

    // The first thing said names the conversation, which is what a
    // conversation in a list should read as. Recorded as coming from the
    // message, so a name the user types later outranks it and this one does
    // not come back.
    //
    // 后面每一轮也走同一行。名字不会被它们改掉（record_prompt 的 CASE 只在
    // 还没有名字时才写），但活动时间会 —— 那正是这一行每轮都要跑的理由。
    let opener: String = if text.is_empty() {
        IMAGE_OPENER.to_owned()
    } else {
        text.chars().take(TITLE_CHARS).collect()
    };

    // 一句话记两件事：这条对话刚刚有活动，以及 —— 只有第一次 —— 它叫什么。
    // 两个条件写在同一条语句里（见 record_prompt），所以这里每一轮都调，不
    // 在这一侧判「是不是第一句」：那个判据的权威在库里，而它已经在守着了。
    //
    // 库操作只有一条路。它在阻塞线程池上，所以这一次写不会停住这个运行时上
    // 别的东西 —— 包括 agent driver 的 future，它就在这里 spawn 的。
    on_index(&index, move |store| {
        store.record_prompt(thread_id, &opener).map_err(persistence)
    })
    .await?;

    /* 先落盘、铺进交付会话，再记账，最后才上路。顺序见 attachments.rs 的模块
    头：反过来会留下一条指着不存在字节的账，而那种残留不会自愈。 */
    let attachments = keep_bytes(
        state.attachments.clone(),
        assets.inner().clone(),
        thread_id.to_string(),
        attached,
    )
    .await?;

    /* 一句话里的图写的是同一张表、属于同一句话：一次借用，一趟阻塞线程。逐张
    各走一次 `on_index`，就是各排一次线程池、各抢一次那把库锁。 */
    on_index(&index, {
        let attachments = attachments.clone();
        move |store| {
            for attachment in &attachments {
                store
                    .remember_attachment(thread_id, attachment)
                    .map_err(persistence)?;
            }

            Ok(())
        }
    })
    .await?;

    /* 准入：意图在这里冻结（幂等键由本机签发），投递欠在发件箱上，随后由
    领域把这一轮送到网关。落账先于上 wire —— 顺序即不变量。 */
    let turn = TurnId::new(Uuid::new_v4().to_string());
    let admission = Admission {
        thread: ThreadId::new(thread_id.to_string()),
        turn: turn.clone(),
        prompt: text.clone(),
        model: configuration
            .iter()
            .find(|selected| selected.id == "model")
            .map(|selected| selected.value.clone())
            .unwrap_or_default(),
        attachments: attachments.iter().map(attachment_reference).collect(),
        skills,
        submitted_at_unix_millis: poietica_time::WallClock::now_unix_millis(
            &poietica_time::wall_clock::SystemWallClock,
        ),
    };
    let delivery = PromptDelivery {
        admission,
        session: addressed.clone(),
    };

    let gateway = KapGateway {
        client: session.client.clone(),
        journal: state.journal.clone(),
        attachments_root: state.attachments.clone(),
    };

    let submit = on_index(&index, move |store| {
        let conversation = Conversation::new(store, &gateway);

        conversation
            .submit(&delivery)
            .map_err(|failure| Error::Internal(failure.to_string()))
    })
    .await?;

    if let Some(failure) = submit.unresolved {
        return Err(Error::Internal(failure.to_string()).into());
    }

    /* 终局记账：收据线在阻塞执行器上等到裁决，账本随后落那一格。 */
    if let Some(receipt) = submit.receipt {
        let closing = app.clone();
        let client = session.client.clone();
        let reported = addressed.clone();
        let turn_for_settlement = turn.clone();

        async_runtime::spawn(async move {
            let settled = async_runtime::spawn_blocking(move || receipt.settle()).await;

            if let Ok(Some(outcome)) = settled {
                let index = closing.state::<LocalIndex>();
                let recorded = on_index(&index, move |store| {
                    store
                        .record_delivery(&turn_for_settlement, outcome)
                        .map_err(|failure| Error::Internal(failure.to_string()))
                })
                .await;
                if let Err(error) = recorded {
                    log::error!("could not record the delivery outcome: {error}");
                }
            } else {
                log::warn!("the delivery receipt ended without a verdict");
            }

            /* 一轮收尾，目标的轮次、用量与状态都变了：问一次 agent，别停在上一轮。 */
            announce(&closing, &client, reported).await;
        });
    }

    Ok(AgentPromptResult {
        session_id: addressed,
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
/// 只读寻址，不惊动 agent。查不到就是没有什么可停的 —— 走 `session_for` 会为一条
/// 还没开过口的对话新开一个会话，那是纯副作用。
///
/// 它是 async 的，因为它要读一次库。同步命令跑在主线程上，而一次库读可能要等
/// 写锁，最长等满 `DEFAULT_BUSY_TIMEOUT`，窗口会在那段时间里停止应答
/// （见 `on_index`）。
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
/// 动的可能是 B 的东西。与 session_for 和 agent_delete_thread 同一条规矩。
async fn held_session(
    index: &State<'_, LocalIndex>,
    thread_id: &str,
    agent_id: &str,
    missing: &str,
) -> AgentCommandResult<String> {
    let id = conversation(thread_id)?;
    let stored = on_index(index, move |store| store.thread(id).map_err(persistence)).await?;

    stored
        .and_then(|thread| {
            let owner = thread.agent_id;

            thread
                .session_id
                .filter(|_| owner.as_deref().is_none_or(|agent| agent == agent_id))
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
