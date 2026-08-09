//! 一个轮次：发起、停止、回答权限、收摊。
//!
//! 帧不逐条发给界面 —— 攒一拍再交货，否则渲染进程被事件淹掉。

use crate::asset_protocol::AssetProtocolRegistry;
use crate::error::Error;
use poietica_agent_persistence_native::TurnSpan;
use poietica_agent_runtime_native::{FrameSink, RecordedEvent};
use tauri::{AppHandle, Emitter, Manager, State, async_runtime};
use tokio::sync::mpsc;
use tokio::time::{Instant, timeout_at};

use super::addressing::{Wanted, session_for};
use super::attachment::{Kept, keep_bytes};
use super::dto::{
    AgentCancelRequest, AgentPromptRequest, AgentPromptResult, AgentResolvePermissionRequest,
};
use super::failure::translate;
use super::runtime::{AgentRuntime, borrow, ensure_session};
use super::store::{conversation, on_store, persistence};
use super::{
    AGENT_EVENT, AgentCommandResult, FRAME_INTERVAL, IMAGE_OPENER, NO_CONVERSATION, NO_SESSION,
    NOTHING_TO_STOP, TITLE_CHARS,
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
    assets: State<'_, AssetProtocolRegistry>,
    request: AgentPromptRequest,
) -> AgentCommandResult<AgentPromptResult> {
    let text = request.text.trim().to_owned();
    let attached = request.assets;
    let mcp = request.mcp_servers;

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
    // 这里为它开一个并记下来 —— 这是 ACP 的会话模型。
    let named = request
        .thread_id
        .as_deref()
        .ok_or_else(|| Error::Validation(NO_CONVERSATION.to_owned()))?;

    /* 提问不需要历史：屏幕上正看着的就是这条对话。 */
    let held = session_for(&state, &session, named, Wanted::Address, mcp).await?;
    let thread_id = held.thread_id;
    let addressed = held.session_id;

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
    // 别的东西 —— 包括 ACP driver 的 future，它就在这里 spawn 的。
    let turn = on_store(&state, move |store| {
        store.record_prompt(thread_id, &opener).map_err(persistence)
    })
    .await?;

    /* 先落盘、铺进交付会话，再记账，最后才上路。顺序见 attachments.rs 的模块
    头：反过来会留下一条指着不存在字节的账，而那种残留不会自愈。 */
    let Kept {
        carried,
        ledger,
        urls,
    } = keep_bytes(
        state.attachments.clone(),
        assets.inner().clone(),
        thread_id.to_string(),
        attached,
        turn,
    )
    .await?;

    /* 一句话里的图写的是同一张表、属于同一句话：一次借用，一趟阻塞线程。逐张
    各走一次 `on_store`，就是各排一次线程池、各抢一次那把库锁。 */
    on_store(&state, move |store| {
        for attachment in ledger {
            store
                .remember_attachment(thread_id, &attachment)
                .map_err(persistence)?;
        }

        Ok(())
    })
    .await?;

    /* 这一轮的起点：命令发出去这一刻。记录器盖在 run_started 上的戳与它是
       同一个时钟、同一个动作的两侧 —— 中间隔着一次到驱动器的排队，差不出一
       毫秒。之所以在这里另记一本账：agent 经 session/load 交还的历史不带任何
       原来的时刻（协议里没有这一格），重启之后封条的耗时只能由这本账回答。 */
    let asked_at = epoch_millis();

    /* 落定的那一趟还要碰一次库，先把手上的 AppHandle 复制一份交过去。 */
    let settle_app = app.clone();

    let frames = batched(app);

    let answer = session
        .client
        .prompt(addressed.clone(), text, carried, frames)
        .map_err(translate)?;

    async_runtime::spawn(async move {
        let outcome = answer.await;

        /* 三种结局都算落定：答复、失败、对面没了 —— 这一轮的时长不因结局而
           改写。轮次号就是 record_prompt 发的那一号，与附件同一把尺子。记不上
           只留一行日志：封条退回没有耗时的旧样子，不是这一轮的失败。 */
        let span = TurnSpan {
            turn,
            started_at: asked_at,
            ended_at: epoch_millis(),
        };
        let state = settle_app.state::<AgentRuntime>();
        let recorded = on_store(&state, move |store| {
            store.record_turn_span(thread_id, &span).map_err(persistence)
        })
        .await;

        if let Err(error) = recorded {
            log::warn!("could not record the turn span: {error}");
        }

        match outcome {
            // A turn that ends without a word looks, from the outside, exactly
            // like a turn that never reached the agent. The stop reason is the
            // account the agent gave, so it is written down even when nothing
            // went wrong.
            Ok(Ok(stop_reason)) => log::info!("the agent turn stopped: {stop_reason:?}"),
            // Both of these were already recorded as a run_failed frame; the
            // log entry here is for the developer, not for the interface.
            Ok(Err(error)) => log::error!("the agent turn failed: {error}"),
            Err(_dropped) => log::warn!("the agent turn ended without an answer"),
        }
    });

    Ok(AgentPromptResult {
        session_id: addressed,
        images: urls,
    })
}

/// 帧攒着走，一拍一趟。
///
/// 一帧一次 emit，就是一个 token 一次全量序列化、一次跨进程投递、一次 webview
/// 事件派发；而收帧的那一侧只按屏幕的节拍看一眼（transcript-store 的 `#paint`）。
/// 投递因此服从屏幕，不服从 agent 吐字的速度。
///
/// 攒批站在自己的任务上，所以跨进程投递不在 ACP 读循环上。
///
/// 序列化仍然在。一帧 acp_update 的 JSON 是在 SDK 的通知处理器里做出来的
/// （agent-runtime 的 frame.rs::acp_update：一次 serde_json::to_value 加一次递归
/// prune），而那个处理器是原子的 —— 它返回之前这条连接上不再处理任何一条消息
/// （driver.rs 的 on_receive_request 引的是同一节 SDK 规约）。这条路上最贵的两
/// 件事，只挪走了一件。
///
/// 每一帧的等待有上界：一批从它的第一帧起算，满 [`FRAME_INTERVAL`] 就交货，其
/// 间没有新帧也一样。上界是这条通道唯一的时间承诺 —— 靠「下一帧会来」推动交货
/// 给不出上界，而一次工具调用宣告之后 agent 正是沉默着去干活的。
fn batched(app: AppHandle) -> FrameSink {
    let (arrived, mut arriving) = mpsc::unbounded_channel::<RecordedEvent>();

    async_runtime::spawn(async move {
        let mut held: Vec<RecordedEvent> = Vec::new();

        while let Some(first) = arriving.recv().await {
            let deadline = Instant::now() + FRAME_INTERVAL;

            held.push(first);

            while let Ok(Some(next)) = timeout_at(deadline, arriving.recv()).await {
                held.push(next);
            }

            // 渲染层没在听不是错：这条对话下次打开时，历史由持有它的 agent
            // 随 agent_open_thread 一起交回来。
            let _ignored = app.emit(AGENT_EVENT, &held);

            held.clear();
        }
    });

    Box::new(move |event: RecordedEvent| {
        /* 收批的那一端与这条连接同寿；它先走了，这一轮剩下的帧就没有去处。 */
        let _closed = arrived.send(event);
    })
}

/// Answers a permission request the agent is blocked on.
///
/// # Errors
///
/// Fails when the request is not outstanding, when the option was never
/// offered, or when the agent has already stopped waiting.
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
        .answer(&request.request_id, &request.option_id)
        .map_err(|error| Error::NotFound(error.to_string()))?;

    Ok(())
}

/// Asks the agent to stop the turn running on one conversation.
///
/// 取消点名一条对话。ACP 的取消是发给一条会话的，而一条对话持有一条会话 ——
/// 这条对应关系在打开这条对话时就写进了库（`attach_session`），提问走的也是它。
///
/// 只读寻址，不惊动 agent。查不到就是没有什么可停的 —— 走 `session_for` 会为一条
/// 还没开过口的对话新开一个会话，那是纯副作用。
///
/// 它是 async 的，因为它要读一次库。同步命令跑在主线程上，而一次库读可能要等
/// 写锁，最长等满 `DEFAULT_BUSY_TIMEOUT`，窗口会在那段时间里停止应答
/// （见 `on_store`）。
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
    request: AgentCancelRequest,
) -> AgentCommandResult<()> {
    let live = borrow(&state)?.ok_or_else(|| Error::NotFound(NO_SESSION.to_owned()))?;

    let id = conversation(&request.thread_id)?;
    let stored = on_store(&state, move |store| store.thread(id).map_err(persistence)).await?;

    /* 持有者对不上就不发：会话号活在各自 agent 的命名空间里，把 A 的号发给 B
    停的可能是 B 的东西。与 session_for 和 agent_delete_thread 同一条规矩。 */
    let held = stored.and_then(|thread| {
        let owner = thread.agent_id;

        thread
            .session_id
            .filter(|_| owner.as_deref().is_none_or(|agent| agent == live.agent_id))
    });

    let Some(addressed) = held else {
        return Err(Error::NotFound(NOTHING_TO_STOP.to_owned()).into());
    };

    /* 本次连接认不得的号是上次运行留下的：那条会话上没有这一侧发起的轮次。
    判据取自驱动器路由帧用的同一本册子 —— 它认得，才有轮次可停。 */
    if live.book.slot(&addressed).map_err(translate)?.is_none() {
        return Err(Error::NotFound(NOTHING_TO_STOP.to_owned()).into());
    }

    live.client.cancel(addressed).map_err(translate)?;

    Ok(())
}

/// Ends the session and lets the agent process exit.
///
/// # Errors
///
/// Fails when the session lock was poisoned.
#[tauri::command]
#[specta::specta]
pub fn agent_shutdown(state: State<'_, AgentRuntime>) -> AgentCommandResult<()> {
    state.disconnect()?;

    Ok(())
}

/// 现在，epoch 毫秒。
///
/// 与 recorder.rs 的 now_millis 同一个算法，两处各写一遍：那个函数是运行时
/// crate 的私有物，而「毫秒怎么说」不值得为它开一个公共出口。时钟不对劲时
/// 算 0 也是同款：封条少一个数字，不少一轮。
fn epoch_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| i64::try_from(elapsed.as_millis()).ok())
        .unwrap_or_default()
}
