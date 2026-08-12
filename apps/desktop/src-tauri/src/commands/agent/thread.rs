//! 对话本身：列、开、改名、归档、删、置顶。

use crate::asset_protocol::AssetProtocolRegistry;
use crate::attachments::forget_blob;
use crate::error::{Error, Result};
use crate::local_index::{LocalIndex, conversation, counted, on_index, persistence};
use crate::paths::{agent_home, remove_projectless_workspace};
use poietica_agent_persistence_native::TitleSource;
use std::path::PathBuf;
use tauri::{AppHandle, State, async_runtime};

use super::addressing::{Held, Wanted, session_for};
use super::attachment::deliver_attachments;
use super::config::restate;
use super::dto::{
    AgentArchiveThreadRequest, AgentForkThreadRequest, AgentOpenThreadRequest, AgentOpenedThread,
    AgentPinThreadRequest, AgentRenameThreadRequest, AgentThread, AgentThreadRequest,
    AgentTitleSource, AgentTurnSpan, FALLBACK_THREAD_TITLE, NO_THREAD,
};
use super::failure::translate;
use super::kimi_state::sync_kimi_archive_state;
use super::runtime::{AgentRuntime, borrow, ensure_session};
use super::{AgentCommandResult, NO_ANSWER, NO_FORK, NOTHING_TO_FORK, TITLE_CHARS};

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
    f64。转换前显式验证 JavaScript 安全整数边界，避免异常数据静默丢失精度。 */
    let mut span_dtos = Vec::with_capacity(spans.len());

    for span in spans {
        span_dtos.push(AgentTurnSpan {
            turn: counted(span.turn)?,
            started_at: ipc_epoch_millis(span.started_at)?,
            ended_at: ipc_epoch_millis(span.ended_at)?,
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

const MAX_SAFE_INTEGER: i64 = (1_i64 << 53) - 1;

#[allow(
    clippy::cast_precision_loss,
    reason = "the value is checked against the exact integer range before conversion"
)]
fn ipc_epoch_millis(value: i64) -> Result<f64> {
    if !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&value) {
        return Err(Error::Internal(
            "a stored epoch millisecond timestamp does not fit the IPC number".to_owned(),
        ));
    }

    Ok(value as f64)
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
/// 当场送达要三个前提：连接还活着、这条会话确实是这个 agent 的、它声明了
/// 这项能力。凑不齐就先记进处置账 —— 不为此去起一个进程：删一条对话不该
/// 是拉起一个 agent 的理由。账由下一次对上这个 agent 的连接握手后冲销
/// （runtime.rs 的 record_and_flush_disposals）。
///
/// 无项目对话还占着一个应用替它签发的工作目录（paths.rs 的
/// create_projectless_workspace）。库里最后一条指着它的行删掉后，目录一并
/// 回收：它与会话同寿，会话没了它就只是一个没人能再找到的空壳。
///
/// # Errors
///
/// Fails when the identifier is not a UUID or the database rejects the
/// deletes.
#[tauri::command]
#[specta::specta]
pub async fn agent_delete_thread(
    app: AppHandle,
    state: State<'_, AgentRuntime>,
    index: State<'_, LocalIndex>,
    request: AgentThreadRequest,
) -> AgentCommandResult<()> {
    let id = conversation(&request.thread_id)?;

    let stored = on_index(&index, move |store| store.thread(id).map_err(persistence)).await?;

    /* 无项目目录与最后一条指着它的对话同寿（paths.rs 的
    create_projectless_workspace），回收凭的就是库里这一行字。 */
    let recorded_root = stored
        .as_ref()
        .and_then(|thread| thread.workspace_root.clone());

    let live = borrow(&state)?;

    /* 号与主人成对拿走：迁移 0012 的触发器保证有号必有主，所以 zip 折不掉
    一笔真实的账。持有者对不上就不当场发 —— 会话号活在各自 agent 的命名空
    间里，把 A 的号发给 B，删的可能是 B 的东西。 */
    let held = stored.and_then(|thread| thread.session_id.zip(thread.agent_id));

    /* 能当场送达就当场送达：连接活着、主人对得上、能力声明过。当场没送达
    的进处置账，由下一次对上这个 agent 的连接握手后冲销（runtime.rs 的
    record_and_flush_disposals）——「不为删一条对话去起进程」这条规矩保留，
    而账不再丢。 */
    let mut owed = held;

    if let Some(live) = &live
        && let Some((session_id, owner)) = owed.clone()
        && live.can_delete_session
        && owner == live.agent_id
    {
        match live.client.delete_session(session_id).await {
            Ok(()) => owed = None,
            /* agent 拒绝，或者它自己也早就不留着这条会话了。本地这一份仍然
            要删：用户按的是删除，不是「如果 agent 同意就删除」。账照记 ——
            冲账那侧送达一次后无论答复如何都销账，毒不了队列。册子那一侧不
            归这里管：驱动器只在 agent 真的删了之后才销号（driver.rs 的
            Settled::Deleted 判 outcome.is_ok）。 */
            Err(error) => {
                log::warn!("could not delete the session on the agent: {error}");
            }
        }
    }

    /* 删对话正是垃圾产生的时刻，所以回收就在这里，不另立一条定时清理。
    行先删、文件后删：反过来崩在中间会留下一条指着空文件的账，而这一个
    方向留下的孤儿文件下一次删除时会被再扫出来。

    删行与扫孤儿共用一次借用。拆成两趟不只是多排一次线程池、多抢一次那把库
    锁：两次上锁之间那道缝里，别人读到的是「对话行没了、附件账还在」——一个
    谁都不该看见的中间态。 */
    let (orphans, released) = on_index(&index, move |store| {
        /* 欠账与删行同一次借用落库：中间没有一道「行没了、账还没记」的缝。 */
        if let Some((session_id, owner)) = owed {
            store
                .record_session_disposal(&session_id, &owner)
                .map_err(persistence)?;
        }

        store.delete_thread(id).map_err(persistence)?;

        let orphans = store.unreferenced_attachments().map_err(persistence)?;

        for hash in &orphans {
            store.forget_attachment(hash).map_err(persistence)?;
        }

        /* 行删完才问引用：问的是「删掉这一行之后还有没有人指着那个目录」，
        问早了答案里包着自己。 */
        let released = match recorded_root {
            Some(freed) if !store.workspace_root_in_use(&freed).map_err(persistence)? => {
                Some(freed)
            }
            _held_or_absent => None,
        };

        Ok((orphans, released))
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

        /* 无项目目录殿后：删不掉不拦附件也不拦答复，下一次启动的对账会再来
        （bootstrap/app.rs）。 */
        if let Some(freed) = released
            && let Err(error) = remove_projectless_workspace(&app, &freed)
        {
            log::warn!("could not remove the projectless workspace: {error}");
        }
    });

    Ok(())
}

/// 从一条对话分叉出一条新对话（ACP session/fork），源对话原样不动。
///
/// 历史归 agent 所有，本地只有索引，所以「带着完整上下文另起一条」是协议
/// 动作，不是本地复制。Codex 的 fork 同一个语义：分出的那条从此各走各的。
///
/// 寻址不走 session_for：那条规则在装载不成时会新开一条空会话并改写持有
/// 关系，对打开与提问那是正确的兜底，对分叉则是把「分叉」静默降级成「新
/// 建」。这里的规矩相反 —— 源会话必须原样变活（还不活就 session/load，号
/// 不变），变不活就明说失败，源对话的持有关系一个字都不改。
///
/// 分叉出的新号与新行在同一句 SQL 里落库（fork_thread：号与主人成对）。
/// 打开它走 agent_open_thread 那条已有的路，历史由 session/load 重放 ——
/// 取历史只有一条管线。
///
/// # Errors
///
/// Fails when the agent cannot be started, when it does not declare session
/// forking, when the conversation has no session this agent holds, or when
/// the fork or the database write is refused.
#[tauri::command]
#[specta::specta]
pub async fn agent_fork_thread(
    app: AppHandle,
    state: State<'_, AgentRuntime>,
    index: State<'_, LocalIndex>,
    request: AgentForkThreadRequest,
) -> AgentCommandResult<AgentThread> {
    let source = conversation(&request.thread_id)?;
    let live = ensure_session(&app, &state, request.launch, request.cwd).await?;

    if !live.can_fork_session {
        return Err(Error::Validation(NO_FORK.to_owned()).into());
    }

    let stored = on_index(&index, move |store| store.thread(source).map_err(persistence))
        .await?
        .ok_or_else(|| Error::Validation(NOTHING_TO_FORK.to_owned()))?;

    /* 号与主人成对（迁移 0012），对不上当前连接的 agent 就不发：会话号活
    在各自 agent 的命名空间里。 */
    let held = stored
        .session_id
        .zip(stored.agent_id)
        .filter(|(_session, owner)| *owner == live.agent_id)
        .map(|(session, _owner)| session)
        .ok_or_else(|| Error::Validation(NOTHING_TO_FORK.to_owned()))?;

    /* 目录是对话的属性，不是这一刻的选择 —— 与 addressing 同一条规矩。 */
    let workspace = match stored.workspace_root {
        Some(path) => PathBuf::from(path),
        None => state.root.clone(),
    };

    /* 上次运行留下的号先原样装载成活地址；装载失败就失败，不换号。 */
    let known = live.book.slot(&held).map_err(translate)?.is_some();

    if !known {
        if !live.can_load_session {
            return Err(Error::Validation(NOTHING_TO_FORK.to_owned()).into());
        }

        live.client
            .load_session(held.clone(), workspace.clone())
            .await
            .map_err(translate)?;
    }

    let forked = live
        .client
        .fork_session(held, workspace)
        .await
        .map_err(translate)?;

    let attached = forked.session_id;
    let owner = live.agent_id.clone();

    let thread = on_index(&index, move |store| {
        let id = store
            .fork_thread(source, &attached, &owner)
            .map_err(persistence)?;

        store
            .thread(id)
            .map_err(persistence)?
            .ok_or_else(|| Error::Validation(NO_THREAD.to_owned()))
    })
    .await?;

    Ok(retitle(thread))
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
