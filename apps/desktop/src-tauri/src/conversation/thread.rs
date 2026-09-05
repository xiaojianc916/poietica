//! 对话本身：列、开、改名、归档、删、置顶。

use crate::asset_protocol::AssetProtocolRegistry;
use crate::error::{Error, Result};
use crate::ledger::{LocalIndex, conversation};
use crate::paths::remove_projectless_workspace;
use poietica_asset::blob::forget_blob;
use poietica_kap_client::PROMPT_ADMITTED;
use poietica_ledger::execution::{read_index, write_index};
use poietica_ledger::index::TitleSource;
use tauri::{AppHandle, State, async_runtime};

use super::attachment::deliver_attachments;
use super::config::restate;
use super::dto::{
    AgentArchiveThreadRequest, AgentForkThreadRequest, AgentOpenThreadRequest, AgentOpenedThread,
    AgentPinThreadRequest, AgentRenameThreadRequest, AgentSessionUsage, AgentThread,
    AgentThreadRequest, AgentThreadSnapshot, AgentThreadTarget, AgentTitleSource,
    AgentTranscriptJson, FALLBACK_THREAD_TITLE, NO_THREAD, reported_goal,
};
use super::failure::translate;
use super::runtime::AgentRuntime;
use super::{AgentCommandResult, NO_ANSWER, NOTHING_TO_FORK, TITLE_CHARS};
use poietica_conversation_runtime::connection::Takeover;
use poietica_conversation_runtime::session::{SessionHistory, read_point};

/// Lists the stored conversations, newest first.
///
/// A read, and nothing but a read: the names come from the ranking in
/// [`TitleSource`], not from the agent's own session list.
///
/// # Errors
///
/// Fails when the database cannot be opened or read.
#[tauri::command]
#[specta::specta]
pub async fn agent_threads(index: State<'_, LocalIndex>) -> AgentCommandResult<Vec<AgentThread>> {
    let stored = read_index(&index, |store| store.list_threads().map_err(Error::from)).await?;

    Ok(stored.into_iter().map(retitle).collect())
}

/// Reads the bounded local transcript snapshot without starting an agent.
#[tauri::command]
#[specta::specta]
pub async fn agent_thread_snapshot(
    index: State<'_, LocalIndex>,
    request: AgentThreadRequest,
) -> AgentCommandResult<AgentThreadSnapshot> {
    let thread_id = conversation(&request.thread_id)?;
    let (thread, usage) = read_index(&index, move |store| {
        let stored = store
            .thread(thread_id)
            .map_err(Error::from)?
            .ok_or_else(|| Error::Internal(NO_THREAD.to_owned()))?;
        let usage = match stored.session_id.as_deref() {
            Some(session) => store
                .session_usage(session)
                .map_err(Error::from)?
                .map(reported)
                .transpose()?,
            None => None,
        };

        Ok((retitle(stored), usage))
    })
    .await?;

    Ok(AgentThreadSnapshot { thread, usage })
}

/// Opens the stored identity and reads the agent-owned transcript; recovery does not replace identity.
#[tauri::command]
#[specta::specta]
pub async fn agent_open_thread(
    state: State<'_, AgentRuntime>,
    index: State<'_, LocalIndex>,
    assets: State<'_, AssetProtocolRegistry>,
    request: AgentOpenThreadRequest,
) -> AgentCommandResult<AgentOpenedThread> {
    let asked = request.cwd.clone();
    let live = state
        .ensure(request.launch.agent_id, request.cwd, Takeover::Replace)
        .await?;

    let named = match request.target {
        AgentThreadTarget::Create { thread_id } => {
            let id = conversation(&thread_id)?;
            write_index(&index, move |store| {
                store
                    .create_thread(id, FALLBACK_THREAD_TITLE, asked.as_deref())
                    .map(|_| ())
                    .map_err(Error::from)
            })
            .await?;
            thread_id
        }
        AgentThreadTarget::Existing { thread_id } => thread_id,
    };

    let mut held = state
        .sessions()
        .resolve(
            &index,
            &live.client,
            &live.book,
            &live.agent_id,
            state.root(),
            &named,
        )
        .await
        .map_err(Error::from)?;

    let thread_id = held.thread_id;
    let session_id = held.session_id.clone();
    let offered = held.offered.take();
    let history = held.history;
    let current_session = session_id.clone();
    let offered_goal = async {
        if let Some(offered) = offered {
            let goal = live
                .client
                .goal(current_session.clone())
                .await
                .map_err(translate)?
                .map(reported_goal);
            return Ok::<_, Error>((offered, goal));
        }

        let answer = live
            .client
            .selectors(current_session.clone())
            .map_err(translate)?;
        let (offered, goal) = tokio::try_join!(
            async {
                answer
                    .await
                    .map_err(|_dropped| Error::Internal(NO_ANSWER.to_owned()))?
                    .map_err(translate)
            },
            async {
                live.client
                    .goal(current_session.clone())
                    .await
                    .map_err(translate)
                    .map(|goal| goal.map(reported_goal))
            },
        )?;
        Ok((offered, goal))
    };
    let ((offered, goal), transcript) = tokio::try_join!(offered_goal, async {
        live.client
            .read_transcript(session_id.clone(), "main".to_owned(), None)
            .await
            .map_err(translate)
    },)?;

    // A just-created fallback row is absent from the ordinary conversation list.
    let thread = read_index(&index, move |store| {
        store
            .thread(thread_id)
            .map_err(Error::from)?
            .map(retitle)
            .ok_or_else(|| Error::Internal(NO_THREAD.to_owned()))
    })
    .await?;

    deliver_attachments(&state, &index, &assets, thread_id).await?;

    Ok(AgentOpenedThread {
        thread,
        selectors: offered.into_iter().map(restate).collect(),
        goal,
        history: match history {
            SessionHistory::Fresh => super::dto::AgentHistory::Fresh,
            SessionHistory::Loaded => super::dto::AgentHistory::Loaded,
            SessionHistory::Live => super::dto::AgentHistory::Live,
        },
        transcript: AgentTranscriptJson {
            json: transcript.to_string(),
        },
    })
}

/// Restates one stored conversation in the shape the bindings carry.
fn retitle(thread: poietica_ledger::index::ThreadSummary) -> AgentThread {
    AgentThread {
        thread_id: thread.id,
        session_id: thread.session_id,
        title: thread.title,
        title_source: match thread.title_source {
            TitleSource::Message => AgentTitleSource::Message,
            TitleSource::Generated => AgentTitleSource::Generated,
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
fn reported(recorded: poietica_ledger::index::SessionUsage) -> Result<AgentSessionUsage> {
    fn unsigned(value: i64) -> Result<u64> {
        u64::try_from(value)
            .map_err(|_| Error::Persistence("a stored usage counter is negative".to_owned()))
    }
    Ok(super::dto::reported_usage(
        poietica_kap_client::SessionUsageSnapshot {
            used: unsigned(recorded.used)?,
            size: unsigned(recorded.size)?,
            input_other: unsigned(recorded.input_other)?,
            input_cache_read: unsigned(recorded.input_cache_read)?,
            input_cache_creation: unsigned(recorded.input_cache_creation)?,
        },
    ))
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

    write_index(&index, move |store| {
        store.name_by_user(id, &title).map_err(Error::from)
    })
    .await?;

    Ok(())
}

/// Archives or restores a conversation.
#[tauri::command]
#[specta::specta]
pub async fn agent_archive_thread(
    index: State<'_, LocalIndex>,
    request: AgentArchiveThreadRequest,
) -> AgentCommandResult<()> {
    let id = conversation(&request.thread_id)?;
    let archived = request.archived;

    write_index(&index, move |store| {
        let exists = store.thread(id).map_err(Error::from)?.is_some();
        if !exists {
            return Err(Error::Validation(
                "the conversation does not exist".to_owned(),
            ));
        }
        store.set_archived(id, archived).map_err(Error::from)
    })
    .await?;

    Ok(())
}

/// Deletes local records and records any remote archive still owed.
#[tauri::command]
#[specta::specta]
pub async fn agent_delete_thread(
    app: AppHandle,
    state: State<'_, AgentRuntime>,
    index: State<'_, LocalIndex>,
    request: AgentThreadRequest,
) -> AgentCommandResult<()> {
    let id = conversation(&request.thread_id)?;
    let _lease = state.sessions().exclusive(id).await;

    let stored = read_index(&index, move |store| store.thread(id).map_err(Error::from)).await?;

    /* 无项目目录与最后一条指着它的对话同寿（paths.rs 的
    create_projectless_workspace），回收凭的就是库里这一行字。 */
    let recorded_root = stored
        .as_ref()
        .and_then(|thread| thread.workspace_root.clone());

    let live = state.current()?;

    /* 号与主人成对拿走：库上的 threads_session_needs_owner 保证有号必有主，
    所以 zip 折不掉一笔真实的账。持有者对不上就不当场发 —— 会话号活在各自
    agent 的命名空间里，把 A 的号发给 B，删的可能是 B 的东西。 */
    let held = stored.and_then(|thread| thread.session_id.zip(thread.agent_id));

    /* 能当场送达就当场送达：连接活着、主人对得上。当场没送达的进处置账，由
    下一次对上这个 agent 的连接握手后冲销（runtime.rs 的
    poietica_conversation_runtime::disposal::discharge）——「不为删一条对话去起进程」这条规矩保留，
    而账不再丢。 */
    let mut owed = held;

    if let Some(live) = &live
        && let Some((session_id, owner)) = owed.clone()
        && owner == live.agent_id
    {
        match live.client.delete_session(session_id).await {
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

    // Remove ledger references before reclaiming their bytes.
    let (orphans, released) = write_index(&index, move |store| {
        if let Some((session_id, owner)) = owed {
            store
                .record_session_disposal(&session_id, &owner)
                .map_err(Error::from)?;
        }

        store.delete_thread(id).map_err(Error::from)?;

        let orphans = store.unreferenced_attachments().map_err(Error::from)?;

        for hash in &orphans {
            store.forget_attachment(hash).map_err(Error::from)?;
        }

        /* 行删完才问引用：问的是「删掉这一行之后还有没有人指着那个目录」，
        问早了答案里包着自己。 */
        let released = match recorded_root {
            Some(freed) if !store.workspace_root_in_use(&freed).map_err(Error::from)? => {
                Some(freed)
            }
            _held_or_absent => None,
        };

        Ok((orphans, released))
    })
    .await?;

    /* 不 await：删几个文件不该让「删除对话」这个动作在屏幕上多停一会儿。 */
    let root = state.attachments().clone();

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

/// Forks an existing agent-owned session without changing the source conversation.
#[tauri::command]
#[specta::specta]
pub async fn agent_fork_thread(
    state: State<'_, AgentRuntime>,
    index: State<'_, LocalIndex>,
    request: AgentForkThreadRequest,
) -> AgentCommandResult<AgentThread> {
    let source = conversation(&request.thread_id)?;
    let _lease = state.sessions().exclusive(source).await;

    /* 名字是界面按规则算好的（thread-title.ts 的 forkNameOf）；这里只做与
    改名同一条防线：去空白、按上限截断、拒绝空名。 */
    let title: String = request.title.trim().chars().take(TITLE_CHARS).collect();

    if title.is_empty() {
        return Err(Error::Validation("the conversation name is empty".to_owned()).into());
    }

    let live = state
        .ensure(request.launch.agent_id, request.cwd, Takeover::Replace)
        .await?;

    let stored = read_index(&index, move |store| {
        store.thread(source).map_err(Error::from)
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
        let from = read_point(&index, &held).await?;

        live.client
            .load_session(held.clone(), from)
            .await
            .map_err(translate)?;
    }

    let drop_turns = request.drop_turns;

    let forked = live
        .client
        .fork_session(held, drop_turns)
        .await
        .map_err(translate)?;

    let attached = forked.session_id;
    let owner = live.agent_id.clone();

    let thread = write_index(&index, move |store| {
        let id = store
            .fork_thread(
                source,
                &title,
                &attached,
                &owner,
                drop_turns,
                PROMPT_ADMITTED,
            )
            .map_err(Error::from)?;

        store
            .thread(id)
            .map_err(Error::from)?
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

    write_index(&index, move |store| {
        store.set_pinned(id, pinned).map_err(Error::from)
    })
    .await?;

    Ok(())
}
