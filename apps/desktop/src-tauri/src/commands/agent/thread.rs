//! 对话本身：列、开、改名、归档、删、置顶。

use crate::asset_protocol::AssetProtocolRegistry;
use crate::attachments::forget_blob;
use crate::error::{Error, Result};
use crate::local_index::{LocalIndex, conversation, counted, on_index, persistence};
use crate::paths::{agent_home, remove_projectless_workspace};
use poietica_agent_persistence_native::TitleSource;
use serde_json::Value;
use tauri::{AppHandle, State, async_runtime};

use super::addressing::{Held, read_point, session_for};
use super::attachment::deliver_attachments;
use super::config::restate;
use super::dto::{
    AgentArchiveThreadRequest, AgentForkThreadRequest, AgentOpenThreadRequest, AgentOpenedThread,
    AgentPinThreadRequest, AgentRenameThreadRequest, AgentSessionUsage, AgentThread,
    AgentThreadRequest, AgentTitleSource, FALLBACK_THREAD_TITLE, NO_THREAD,
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
/// 认出它存着的会话号不是本次连接开的，于是请 driver 把它订阅回来 —— 号
/// 不变，上下文因此回到 agent 手里。只有装载不回来（号在 server 侧也没了）
/// 时才重开一条。
///
/// 经过来自本机日志（run_events），不来自 agent 的装载重放：那批帧里没有
/// run_started，段边界会整段塌掉，而回填只发生一次 —— 塌掉的形状会永久留在
/// 日志里。agent 装载回来的是模型的上下文，让它自己续得上，不参与投影。
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
        history,
    } = session_for(&state, &index, &live, &named).await?;

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

    「这条对话长什么样」与「它的经过」是同一次打开要的两个答案，所以
    它们共用一次借用：一趟阻塞线程、一次上锁、两条 prepare_cached。拆成两趟就
    是各排一次线程池、各抢一次那把库锁，而打开一条对话正是人点一下就要等的那
    条路径 —— turn.rs 里那批附件写入用的是同一条规矩。 */
    let (thread, usage, frames) = on_index(&index, move |store| {
        let stored = store
            .thread(thread_id)
            .map_err(persistence)?
            .ok_or_else(|| Error::Internal(NO_THREAD.to_owned()))?;

        /* 用量在 retitle 之前取走：AgentThread 是列表的形状，不带这一格。 */
        let usage = match stored.session_id.as_deref() {
            Some(session) => store
                .session_usage(session)
                .map_err(persistence)?
                .map(reported)
                .transpose()?,
            None => None,
        };

        let thread = retitle(stored);

        /* 经过由本地日志重放，而日志只由跑那一轮的那一侧写（turn.rs 的
        logging）。空着就是空着 —— 这台机器没记过它。 */
        let frames = store.frames_of(thread_id).map_err(persistence)?;

        Ok((thread, usage, frames))
    })
    .await?;

    deliver_attachments(&state, &index, &assets, thread_id).await?;

    let events = restored(frames)?;

    Ok(AgentOpenedThread {
        thread,
        selectors: offered.into_iter().map(restate).collect(),
        events,
        history,
        usage,
    })
}

/// 日志里那些行，回到帧的形状。
///
/// 读不成的一行是本地日志坏了，不是这条对话的内容 —— 说出来，不静默跳过。
fn restored(logged: Vec<String>) -> Result<Vec<Value>> {
    let mut events = Vec::with_capacity(logged.len());

    for line in logged {
        events.push(serde_json::from_str(&line).map_err(|error| {
            Error::Internal(format!("a recorded frame could not be read: {error}"))
        })?);
    }

    Ok(events)
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

/// 账本里那份读数与计数，收进线上那一格的宽度。
fn reported(
    recorded: poietica_agent_persistence_native::SessionUsage,
) -> Result<AgentSessionUsage> {
    Ok(AgentSessionUsage {
        used: counted(recorded.used)?,
        size: counted(recorded.size)?,
        input_other: counted(recorded.input_other)?,
        input_cache_read: counted(recorded.input_cache_read)?,
        input_cache_creation: counted(recorded.input_cache_creation)?,
    })
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
/// 对话被删了 —— 屏幕上没了、对面完整留着，那不是删除，是隐藏。kap 没有
/// 硬删除，删除由 :archive 承接。
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

    /* 号与主人成对拿走：库上的 threads_session_needs_owner 保证有号必有主，
    所以 zip 折不掉一笔真实的账。持有者对不上就不当场发 —— 会话号活在各自
    agent 的命名空间里，把 A 的号发给 B，删的可能是 B 的东西。 */
    let held = stored.and_then(|thread| thread.session_id.zip(thread.agent_id));

    /* 能当场送达就当场送达：连接活着、主人对得上、能力声明过。当场没送达
    的进处置账，由下一次对上这个 agent 的连接握手后冲销（runtime.rs 的
    record_and_flush_disposals）——「不为删一条对话去起进程」这条规矩保留，
    而账不再丢。 */
    let mut owed = held;

    if let Some(live) = &live
        && let Some((session_id, owner)) = owed.clone()
        && let Some(deleting) = live.deleting
        && owner == live.agent_id
    {
        match live.client.delete_session(deleting, session_id).await {
            Ok(()) => owed = None,
            /* agent 拒绝，或者它自己也早就不留着这条会话了。本地这一份仍然
            要删：用户按的是删除，不是「如果 agent 同意就删除」。账照记 ——
            冲账那侧送达一次后无论答复如何都销账，毒不了队列。册子那一侧不
            归这里管：驱动器只在 agent 真的归档之后才销号（driver.rs 的
            archive_session）。 */
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

/// 从一条对话分叉出一条新对话（kap :fork），源对话原样不动。
///
/// 两侧各分叉一次：agent 那侧由 session/fork 复制上下文，这一侧由 fork_thread
/// 复制本机日志与附件链接（见 threads.rs）。屏幕上那条时间线由日志重放，日志
/// 不跟过去，分出来的就是一块白板。分出的那条从此各走各的。
///
/// 寻址不走 session_for：那条规则在装载不成时会新开一条空会话并改写持有
/// 关系，对打开与提问那是正确的兜底，对分叉则是把「分叉」静默降级成「新
/// 建」。这里的规矩相反 —— 源会话必须原样变活（还不活就 session/load，号
/// 不变），变不活就明说失败，源对话的持有关系一个字都不改。
///
/// 新号、新行、日志与附件链接在同一次事务里落库（fork_thread：号与主人成
/// 对）。打开它走 agent_open_thread 那条已有的路，取经过只有一条管线：本机
/// 日志。
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

    /* 名字是界面按规则算好的（thread-title.ts 的 forkNameOf）；这里只做与
    改名同一条防线：去空白、按上限截断、拒绝空名。 */
    let title: String = request.title.trim().chars().take(TITLE_CHARS).collect();

    if title.is_empty() {
        return Err(Error::Validation("the conversation name is empty".to_owned()).into());
    }

    let live = ensure_session(&app, &state, request.launch, request.cwd).await?;

    let Some(forking) = live.forking else {
        return Err(Error::Validation(NO_FORK.to_owned()).into());
    };

    let stored = on_index(&index, move |store| {
        store.thread(source).map_err(persistence)
    })
    .await?
    .ok_or_else(|| Error::Validation(NOTHING_TO_FORK.to_owned()))?;

    /* 号与主人成对（threads_session_needs_owner），对不上当前连接的 agent
    就不发：会话号活在各自 agent 的命名空间里。 */
    let held = stored
        .session_id
        .zip(stored.agent_id)
        .filter(|(_session, owner)| *owner == live.agent_id)
        .map(|(session, _owner)| session)
        .ok_or_else(|| Error::Validation(NOTHING_TO_FORK.to_owned()))?;

    /* 上次运行留下的号先原样装载成活地址；装载失败就失败，不换号。 */
    let known = live.book.slot(&held).map_err(translate)?.is_some();

    if !known {
        let Some(loading) = live.loading else {
            return Err(Error::Validation(NOTHING_TO_FORK.to_owned()).into());
        };

        let from = read_point(&index, &held).await?;

        live.client
            .load_session(loading, held.clone(), from)
            .await
            .map_err(translate)?;
    }

    let forked = live
        .client
        .fork_session(forking, held)
        .await
        .map_err(translate)?;

    let attached = forked.session_id;
    let owner = live.agent_id.clone();

    let thread = on_index(&index, move |store| {
        let id = store
            .fork_thread(source, &title, &attached, &owner)
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
