//! Desktop DTO projection and platform attachment delivery.
use super::dto::{
    AgentArchiveThreadRequest, AgentForkThreadRequest, AgentOpenThreadRequest, AgentOpenedThread,
    AgentPinThreadRequest, AgentRenameThreadRequest, AgentSessionUsage, AgentThread,
    AgentThreadRequest, AgentThreadSnapshot, AgentThreadTarget, AgentTitleSource,
    AgentTranscriptJson, reported_goal,
};
use super::{AgentCommandResult, AgentRuntime, attachment::deliver_attachments, config::restate};
use crate::asset_protocol::AssetProtocolRegistry;
use crate::error::{Error, Result};
use crate::ledger::LocalIndex;
use crate::paths::remove_projectless_workspace;
use poietica_asset::blob::forget_blob;
use poietica_conversation_runtime::{
    ForkThread, OpenThread, SessionHistory, ThreadTarget,
    catalog::{self, ThreadChange},
};
use poietica_ledger::{execution::read_index, index::TitleSource};
use tauri::{AppHandle, State, async_runtime};

#[tauri::command]
#[specta::specta]
pub async fn agent_threads(index: State<'_, LocalIndex>) -> AgentCommandResult<Vec<AgentThread>> {
    let stored = read_index(&index, |store| store.list_threads().map_err(Error::from)).await?;
    Ok(stored.into_iter().map(retitle).collect())
}

#[tauri::command]
#[specta::specta]
pub async fn agent_thread_snapshot(
    index: State<'_, LocalIndex>,
    request: AgentThreadRequest,
) -> AgentCommandResult<AgentThreadSnapshot> {
    let (thread, usage) = catalog::snapshot(&index, &request.thread_id).await?;
    Ok(AgentThreadSnapshot {
        thread: retitle(thread),
        usage: usage.map(reported).transpose()?,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn agent_open_thread(
    state: State<'_, AgentRuntime>,
    index: State<'_, LocalIndex>,
    assets: State<'_, AssetProtocolRegistry>,
    request: AgentOpenThreadRequest,
) -> AgentCommandResult<AgentOpenedThread> {
    let target = match request.target {
        AgentThreadTarget::Create { thread_id } => ThreadTarget::Create(thread_id),
        AgentThreadTarget::Existing { thread_id } => ThreadTarget::Existing(thread_id),
    };
    let opened = state
        .open_thread(
            OpenThread {
                agent_id: request.launch.agent_id,
                cwd: request.cwd,
                target,
            },
            |id| deliver_attachments(&state, &index, &assets, id),
        )
        .await
        .map_err(Error::from)?;
    Ok(AgentOpenedThread {
        thread: retitle(opened.thread),
        selectors: opened.selectors.into_iter().map(restate).collect(),
        goal: opened.goal.map(reported_goal),
        history: match opened.history {
            SessionHistory::Fresh => super::dto::AgentHistory::Fresh,
            SessionHistory::Loaded => super::dto::AgentHistory::Loaded,
            SessionHistory::Live => super::dto::AgentHistory::Live,
        },
        transcript: AgentTranscriptJson {
            json: opened.transcript,
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

#[tauri::command]
#[specta::specta]
pub async fn agent_rename_thread(
    index: State<'_, LocalIndex>,
    request: AgentRenameThreadRequest,
) -> AgentCommandResult<()> {
    catalog::change(
        &index,
        &request.thread_id,
        ThreadChange::Rename(request.title),
    )
    .await?;
    Ok(())
}
#[tauri::command]
#[specta::specta]
pub async fn agent_archive_thread(
    index: State<'_, LocalIndex>,
    request: AgentArchiveThreadRequest,
) -> AgentCommandResult<()> {
    catalog::change(
        &index,
        &request.thread_id,
        ThreadChange::Archive(request.archived),
    )
    .await?;
    Ok(())
}
#[tauri::command]
#[specta::specta]
pub async fn agent_pin_thread(
    index: State<'_, LocalIndex>,
    request: AgentPinThreadRequest,
) -> AgentCommandResult<()> {
    catalog::change(
        &index,
        &request.thread_id,
        ThreadChange::Pin(request.pinned),
    )
    .await?;
    Ok(())
}
#[tauri::command]
#[specta::specta]
pub async fn agent_delete_thread(
    app: AppHandle,
    state: State<'_, AgentRuntime>,
    request: AgentThreadRequest,
) -> AgentCommandResult<()> {
    let deleted = state
        .delete_thread(&request.thread_id)
        .await
        .map_err(Error::from)?;
    let root = state.attachments().clone();
    let _cleanup = async_runtime::spawn_blocking(move || {
        for hash in deleted.attachments {
            if let Err(error) = forget_blob(&root, &hash) {
                log::warn!("could not remove an unreferenced attachment: {error}");
            }
        }
        if let Some(root) = deleted.workspace
            && let Err(error) = remove_projectless_workspace(&app, &root)
        {
            log::warn!("could not remove the projectless workspace: {error}");
        }
    });
    Ok(())
}
#[tauri::command]
#[specta::specta]
pub async fn agent_fork_thread(
    state: State<'_, AgentRuntime>,
    request: AgentForkThreadRequest,
) -> AgentCommandResult<AgentThread> {
    let thread = state
        .fork_thread(ForkThread {
            agent_id: request.launch.agent_id,
            cwd: request.cwd,
            thread_id: request.thread_id,
            title: request.title,
            drop_turns: request.drop_turns,
        })
        .await
        .map_err(Error::from)?;
    Ok(retitle(thread))
}
