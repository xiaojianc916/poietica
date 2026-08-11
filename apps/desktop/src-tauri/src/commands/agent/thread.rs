//! 对话本身：列、开、改名、归档、删、置顶。

use crate::asset_protocol::AssetProtocolRegistry;
use crate::attachments::forget_blob;
use crate::error::{Error, Result};
use crate::local_index::{LocalIndex, conversation, counted, on_index, persistence};
use crate::paths::agent_home;
use poietica_agent_persistence_native::TitleSource;
use tauri::{AppHandle, State, async_runtime};

use super::addressing::{Held, Wanted, session_for};
use super::attachment::deliver_attachments;
use super::config::restate;
use super::dto::{
    AgentArchiveThreadRequest, AgentOpenThreadRequest, AgentOpenedThread, AgentPinThreadRequest,
    AgentRenameThreadRequest, AgentThread, AgentThreadRequest, AgentTitleSource, AgentTurnSpan,
    FALLBACK_THREAD_TITLE, NO_THREAD,
};
use super::failure::translate;
use super::kimi_state::sync_kimi_archive_state;
use super::runtime::{AgentRuntime, borrow, ensure_session};
use super::{AgentCommandResult, NO_ANSWER, TITLE_CHARS};

/// Lists the stored conversations, newest first.
///
/// A read, and nothing but a read. It used to open with a round trip to the
/// agent for its session list and write those names in, which is where every
/// conversation in this list got the name New Session: that title is what
/// the agent called the session in its own store, it is never revised, and
/// it was ranked above the first thing the user actually said.
///
/// Dropping it takes a subprocess round trip and a write transaction off the
/// path that draws the sidebar, and takes the whole read off the main thread.
/// The names shown are now decided in one place, by the ranking in
/// `TitleSource.`
///
/// # Errors
///
/// Fails when the database cannot be opened or read.
#[tauri::command]
#[specta::specta]
pub async fn agent_threads(index: State<'_, LocalIndex>) -> AgentCommandResult<Vec<AgentThread>> {
    let stored = on_index(&index, |store| store.list_threads().map_err(persistence)).await?;

    Ok(stored.into_iter().map(retitle).collect())
}

/// 打开一条对话：把它整条要回来。
///
/// 不点名就先落一行，再为它开会话；点开一条上次运行留下的对话时，`session_for`
/// 认出它存着的会话号不是本次连接开的，于是请 agent 把那条会话装载回来 —— 号
/// 不变，而 agent 在装载期间用 session/update 把这条对话重放一遍 —— 那些帧就
/// 是历史本身，随这次答复一起交出去。只有 agent 说它不装载旧会话时才重开一条。
///
/// 历史从这里回来，不从别处。屏幕上曾经显示的是本地日志里的另一份，于是同一
/// 段对话有两个来源，而只有一个是 agent 手里那份 —— 两份一旦分叉，人看见的是
/// 对的那份的赝品。现在只有一份，它的持有者是这条会话的主人。
///
/// 每一次打开都问一次经过，本次连接开的那些会话也不例外。渲染层可以在连接
/// 还活着的时候整个重来 —— Ctrl+R 就是，开第二个窗口也是 —— 那一刻它手里什么
/// 都没有，而这一侧只知道"会话还在"。用后者去猜前者，猜错的那次就是一块永远
/// 填不上的白板。
///
/// 三条路都在同一次答复里带回整张选择器表，界面因此从不需要"读一次设置"。
///
/// # Errors
///
/// Fails when the agent cannot be started, when a turn is in flight on
/// the connection, or when the database rejects the write.
#[tauri::command]
#[specta::specta]
pub async fn agent_open_thread(
    app: AppHandle,
    state: State<'_, AgentRuntime>,
    index: State<'_, LocalIndex>,
    assets: State<'_, AssetProtocolRegistry>,
    request: AgentOpenThreadRequest,
) -> AgentCommandResult<AgentOpenedThread> {
    let asked = request.cwd.clone();
    let mcp = request.mcp_servers;
    let live = ensure_session(&app, &state, request.launch, request.cwd).await?;

    let named = if let Some(given) = request.thread_id {
        given
    } else {
        /* 新建的这一条属于此刻这个工作目录，而且从此属于它：之后每一次为这条
        对话开会话都照这一行，不照「渲染层此刻选的那个」。 */
        on_index(&index, move |store| {
            store
                .create_thread(FALLBACK_THREAD_TITLE, asked.as_deref())
                .map(|id| id.to_string())
                .map_err(persistence)
        })
        .await?
    };

    let Held {
        thread_id,
        session_id,
        offered,
        events,
        history,
    } = session_for(&state, &index, &live, &named, Wanted::History, mcp).await?;

    let offered = if let Some(offered) = offered {
        offered
    } else {
        /* 本次运行已经为它开过会话：只有这一种情况需要把表再问一次。 */
        let answer = live.client.selectors(session_id).map_err(translate)?;

        answer
            .await
            .map_err(|_dropped| Error::Internal(NO_ANSWER.to_owned()))?
            .map_err(translate)?
    };

    /* 列表故意漏掉还没有人开口的对话，而刚建的这一行正是那种，所以它只能
    单独读回来。判据现在是标题源，见 threads.rs 的 list_threads。

    「这条对话长什么样」与「它一共问过多少次」是同一次打开要的两个答案，所以
    它们共用一次借用：一趟阻塞线程、一次上锁、两条 prepare_cached。拆成两趟就
    是各排一次线程池、各抢一次那把库锁，而打开一条对话正是人点一下就要等的那
    条路径 —— turn.rs 里那批附件写入用的是同一条规矩。 */
    let (thread, prompts, spans) = on_index(&index, move |store| {
        let thread = store
            .thread(thread_id)
            .map_err(persistence)?
            .map(retitle)
            .ok_or_else(|| Error::Internal(NO_THREAD.to_owned()))?;

        let prompts = store.prompt_count(thread_id).map_err(persistence)?;

        /* 「长什么样」「问过几次」「每一轮各花了多久」是同一次打开要的三个
        答案，所以共用这一次借用 —— 与 prompts 同一条规矩。 */
        let spans = store.turn_spans_of(thread_id).map_err(persistence)?;

        Ok((thread, prompts, spans))
    })
    .await?;

    let attachments = deliver_attachments(&state, &index, &assets, thread_id).await?;

    let prompts = counted(prompts)?;

    /* 账本的轮次号与时刻都是 i64，而这份 IPC 面没有 64 位整数（见 counted
    与 AgentThreadAttachment 的 turn 上那条界线）：轮次收进 u32，时刻放进
    f64 —— epoch 毫秒离 2^53 还远，精度不丢。 */
    let mut span_dtos = Vec::with_capacity(spans.len());

    for span in spans {
        span_dtos.push(AgentTurnSpan {
            turn: counted(span.turn)?,
            started_at: span.started_at as f64,
            ended_at: span.ended_at as f64,
        });
    }

    Ok(AgentOpenedThread {
        thread,
        selectors: offered.into_iter().map(restate).collect(),
        events,
        history,
        attachments,
        spans: span_dtos,
        prompts,
    })
}

/// Restates one stored conversation in the shape the bindings carry.
fn retitle(thread: poietica_agent_persistence_native::ThreadSummary) -> AgentThread {
    AgentThread {
        thread_id: thread.id,
        session_id: thread.session_id,
        title: thread.title,
        title_source: match thread.title_source {
            TitleSource::Message => AgentTitleSource::Message,
            TitleSource::Fallback => AgentTitleSource::Fallback,
            TitleSource::Manual => AgentTitleSource::Manual,
        },
        updated_at: thread.updated_at,
        pinned: thread.pinned,
        workspace_root: thread.workspace_root,
        archived: thread.archived_at.is_some(),
    }
}

/// Renames a conversation.
///
/// The name is recorded as the user's, which outranks the opening message
/// it replaces: that question has already been answered by the person who
/// typed it.
///
/// # Errors
///
/// Fails when the identifier is not a UUID, the name is empty, or the
/// database rejects the write.
#[tauri::command]
#[specta::specta]
pub async fn agent_rename_thread(
    index: State<'_, LocalIndex>,
    request: AgentRenameThreadRequest,
) -> AgentCommandResult<()> {
    let title: String = request.title.trim().chars().take(TITLE_CHARS).collect();

    if title.is_empty() {
        return Err(Error::Validation("the conversation name is empty".to_owned()).into());
    }

    let id = conversation(&request.thread_id)?;

    on_index(&index, move |store| {
        store.name_by_user(id, &title).map_err(persistence)
    })
    .await?;

    Ok(())
}

/// Archives or restores a conversation.
#[tauri::command]
#[specta::specta]
pub async fn agent_archive_thread(
    app: AppHandle,
    index: State<'_, LocalIndex>,
    request: AgentArchiveThreadRequest,
) -> AgentCommandResult<()> {
    let id = conversation(&request.thread_id)?;
    let archived = request.archived;

    let stored = on_index(&index, move |store| {
        store
            .thread(id)
            .map_err(persistence)?
            .ok_or_else(|| Error::Validation("the conversation does not exist".to_owned()))
    })
    .await?;

    /* 分发点留在通用层，Kimi 知识不留：怎么写它官方的 state.json、为什么写，
    都收在 kimi_state.rs。 */
    if stored.agent_id.as_deref() == Some("kimi")
        && let Some(session_id) = stored.session_id
    {
        let home = agent_home(&app, "kimi")?;

        async_runtime::spawn_blocking(move || {
            sync_kimi_archive_state(&home, &session_id, archived)
        })
        .await
        .map_err(|_dropped| {
            Error::Internal("the Kimi archive write did not finish".to_owned())
        })??;
    }

    on_index(&index, move |store| {
        store.set_archived(id, archived).map_err(persistence)
    })
    .await?;

    Ok(())
}

/// Deletes a conversation, on this side and on the agent's.
///
/// 本地那一份是一行索引，一句 DELETE 就没了：这张表底下已经不挂任何东西。
///
/// 真正的那一份在 agent 手里。它存着这条对话的全文，此前从没有人告诉过它这条
/// 对话被删了 —— 屏幕上没了、对面完整留着，那不是删除，是隐藏。ACP 为此
/// 有 session/delete，而它可不可用由 agent 在握手时自己说。
///
/// 三个前提缺一不可：连接还活着、这条会话确实是这个 agent 的、它声明了这
/// 项能力。都不满足就只删本地那一份 —— 并且不为此去起一个进程：删一条对话
/// 不该是拉起一个 agent 的理由。那种情况下 agent 那份会留到下次它自己清理。
///
/// # Errors
///
/// Fails when the identifier is not a UUID or the database rejects the
/// deletes.
#[tauri::command]
#[specta::specta]
pub async fn agent_delete_thread(
    state: State<'_, AgentRuntime>,
    index: State<'_, LocalIndex>,
    request: AgentThreadRequest,
) -> AgentCommandResult<()> {
    let id = conversation(&request.thread_id)?;

    let stored = on_index(&index, move |store| store.thread(id).map_err(persistence)).await?;

    let live = borrow(&state)?;

    /* 持有者对不上就不发：会话号活在各自 agent 的命名空间里，把 A 的号发给
    B，删的可能是 B 的东西。空的持有者是这一列存在之前写下的行，按本次这个
    算 —— 与 session_for 同一条规矩，不另立一套。 */
    let held = stored.and_then(|thread| {
        let owner = thread.agent_id;

        thread.session_id.filter(|_| {
            live.as_ref().is_some_and(|live| {
                live.can_delete_session
                    && owner.as_deref().is_none_or(|agent| agent == live.agent_id)
            })
        })
    });

    if let (Some(live), Some(session_id)) = (live, held)
        && let Err(error) = live.client.delete_session(session_id).await
    {
        /* agent 拒绝，或者它自己也早就不留着这条会话了。本地这一份仍然要删：
        用户按的是删除，不是「如果 agent 同意就删除」。册子那一侧不归这里管 ——
        驱动器只在 agent 真的删了之后才销号（driver.rs 的 Settled::Deleted 判
        outcome.is_ok），此前这一侧无论它答不答应都抹掉号。 */
        log::warn!("could not delete the session on the agent: {error}");
    }

    /* 删对话正是垃圾产生的时刻，所以回收就在这里，不另立一条定时清理。
    行先删、文件后删：反过来崩在中间会留下一条指着空文件的账，而这一个
    方向留下的孤儿文件下一次删除时会被再扫出来。

    删行与扫孤儿共用一次借用。拆成两趟不只是多排一次线程池、多抢一次那把库
    锁：两次上锁之间那道缝里，别人读到的是「对话行没了、附件账还在」——一个
    谁都不该看见的中间态。 */
    let orphans = on_index(&index, move |store| {
        store.delete_thread(id).map_err(persistence)?;

        let orphans = store.unreferenced_attachments().map_err(persistence)?;

        for hash in &orphans {
            store.forget_attachment(hash).map_err(persistence)?;
        }

        Ok(orphans)
    })
    .await?;

    /* 不 await：删几个文件不该让「删除对话」这个动作在屏幕上多停一会儿。 */
    let root = state.attachments.clone();

    let _detached = async_runtime::spawn_blocking(move || {
        for hash in orphans {
            if let Err(error) = forget_blob(&root, &hash) {
                log::warn!("could not remove an unreferenced attachment: {error}");
            }
        }
    });

    Ok(())
}

/// Holds a conversation at the top of the list, or releases it.
///
/// # Errors
///
/// Fails when the identifier is not a UUID or the database rejects the
/// write.
#[tauri::command]
#[specta::specta]
pub async fn agent_pin_thread(
    index: State<'_, LocalIndex>,
    request: AgentPinThreadRequest,
) -> AgentCommandResult<()> {
    let id = conversation(&request.thread_id)?;
    let pinned = request.pinned;

    on_index(&index, move |store| {
        store.set_pinned(id, pinned).map_err(persistence)
    })
    .await?;

    Ok(())
}
