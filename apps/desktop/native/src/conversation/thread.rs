//! Desktop DTO projection and platform attachment delivery.
use super::dto::{
    AgentArchiveThreadRequest, AgentForkThreadRequest, AgentOpenThreadRequest, AgentOpenedThread,
    AgentPinThreadRequest, AgentRenameThreadRequest, AgentSessionUsage, AgentThread,
    AgentThreadRequest, AgentThreadSnapshot, AgentThreadTarget, AgentTitleSource,
    AgentTranscriptJson, reported_goal,
};
use super::{AgentCommandResult, configuration::restate};
use crate::error::{Error, Result};
use crate::workspace::reconcile;
use poietica_asset::blob::forget_blob;
use poietica_conversation_runtime::{
    ForkThread, OpenThread, SessionHistory, ThreadTarget,
    catalog::{self, ThreadChange},
};
use poietica_ledger::{execution::read_index, index::TitleSource};

#[specta::specta]
pub async fn agent_threads() -> AgentCommandResult<Vec<AgentThread>> {
    let index = crate::ledger::index()?;
    let stored = read_index(&index, |store| store.list_threads().map_err(Error::from)).await?;
    Ok(stored.into_iter().map(retitle).collect())
}

#[specta::specta]
pub async fn agent_thread_snapshot(
    request: AgentThreadRequest,
) -> AgentCommandResult<AgentThreadSnapshot> {
    let index = crate::ledger::index()?;
    let (thread, usage) = catalog::snapshot(&index, &request.thread_id).await?;
    Ok(AgentThreadSnapshot {
        thread: retitle(thread),
        usage: usage.map(reported).transpose()?,
    })
}

#[specta::specta]
pub async fn agent_open_thread(
    request: AgentOpenThreadRequest,
) -> AgentCommandResult<AgentOpenedThread> {
    let state = crate::conversation::runtime()?;
    let target = match request.target {
        AgentThreadTarget::Create { thread_id } => ThreadTarget::Create(thread_id),
        AgentThreadTarget::Existing { thread_id } => ThreadTarget::Existing(thread_id),
    };
    let opened = state
        .open_thread(OpenThread {
            agent_id: crate::agent::profile::agent_id()?,
            cwd: request.cwd,
            target,
        })
        .await
        .map_err(Error::from)?;
    Ok(AgentOpenedThread {
        thread: retitle(opened.thread),
        selectors: opened.selectors.into_iter().map(restate).collect(),
        goal: opened.goal.map(reported_goal),
        history: match opened.history {
            SessionHistory::Fresh => super::dto::AgentHistory::Fresh,
            SessionHistory::Loaded => super::dto::AgentHistory::Loaded,
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
        poietica_agent_client::SessionUsageSnapshot {
            used: unsigned(recorded.used)?,
            size: unsigned(recorded.size)?,
            input_other: unsigned(recorded.input_other)?,
            input_cache_read: unsigned(recorded.input_cache_read)?,
            input_cache_creation: unsigned(recorded.input_cache_creation)?,
            breakdown: recorded
                .breakdown
                .map(|breakdown| {
                    Ok::<_, Error>(poietica_agent_client::UsageBreakdownSnapshot {
                        system: unsigned(breakdown.system)?,
                        system_context: unsigned(breakdown.system_context)?,
                        tools: unsigned(breakdown.tools)?,
                        skills: unsigned(breakdown.skills)?,
                        messages: unsigned(breakdown.messages)?,
                        free: unsigned(breakdown.free)?,
                        buffer: unsigned(breakdown.buffer)?,
                    })
                })
                .transpose()?,
        },
    ))
}

#[specta::specta]
pub async fn agent_rename_thread(request: AgentRenameThreadRequest) -> AgentCommandResult<()> {
    let index = crate::ledger::index()?;
    catalog::change(
        &index,
        &request.thread_id,
        ThreadChange::Rename(request.title),
    )
    .await?;
    Ok(())
}
#[specta::specta]
pub async fn agent_archive_thread(request: AgentArchiveThreadRequest) -> AgentCommandResult<()> {
    let index = crate::ledger::index()?;
    catalog::change(
        &index,
        &request.thread_id,
        ThreadChange::Archive(request.archived),
    )
    .await?;
    Ok(())
}
#[specta::specta]
pub async fn agent_pin_thread(request: AgentPinThreadRequest) -> AgentCommandResult<()> {
    let index = crate::ledger::index()?;
    catalog::change(
        &index,
        &request.thread_id,
        ThreadChange::Pin(request.pinned),
    )
    .await?;
    Ok(())
}
#[specta::specta]
pub async fn agent_delete_thread(request: AgentThreadRequest) -> AgentCommandResult<()> {
    let state = crate::conversation::runtime()?;
    let deleted = state
        .delete_thread(&request.thread_id)
        .await
        .map_err(Error::from)?;
    let root = state.attachments().clone();
    let _cleanup = tokio::task::spawn_blocking(move || {
        for hash in deleted.attachments {
            if let Err(error) = forget_blob(&root, &hash) {
                log::warn!("could not remove an unreferenced attachment: {error}");
            }
        }
        if let Some(root) = deleted.workspace {
            // 它是启动对账用过的同一段清理，这里也走它：判定「归我们管的无项目目录」只有一处。
            reconcile::remove_workspace(&root);
        }
    });
    Ok(())
}
#[specta::specta]
pub async fn agent_fork_thread(request: AgentForkThreadRequest) -> AgentCommandResult<AgentThread> {
    let thread = crate::conversation::runtime()?
        .fork_thread(ForkThread {
            agent_id: crate::agent::profile::agent_id()?,
            cwd: request.cwd,
            thread_id: request.thread_id,
            title: request.title,
            drop_turns: request.drop_turns,
        })
        .await
        .map_err(Error::from)?;
    Ok(retitle(thread))
}
