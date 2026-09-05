//! Resolves a conversation without granting recovery failures permission to replace its identity.

use super::NO_SUCH_CONVERSATION;
use super::dto::AgentHistory;
use super::failure::translate;
use super::runtime::{AgentRuntime, Handle};
use crate::error::{Error, Result};
use crate::ipc::commands::ledger::{LocalIndex, conversation};
use poietica_kap_client::{ConfigControl, Cursor};
use poietica_ledger::execution::{read_index, write_index};
use std::path::PathBuf;
use tauri::State;
use uuid::Uuid;

pub(super) struct Held {
    pub(super) thread_id: Uuid,
    pub(super) session_id: String,
    pub(super) offered: Option<Vec<ConfigControl>>,
    pub(super) history: AgentHistory,
}

pub(super) async fn read_point(
    index: &State<'_, LocalIndex>,
    session_id: &str,
) -> Result<Option<Cursor>> {
    let asked = session_id.to_owned();
    let stored = read_index(index, move |store| {
        store.cursor_of(&asked).map_err(Error::from)
    })
    .await?;
    Ok(stored.map(|read| Cursor {
        seq: read.seq,
        epoch: read.epoch,
    }))
}

pub(super) async fn session_for(
    state: &State<'_, AgentRuntime>,
    index: &State<'_, LocalIndex>,
    live: &Handle,
    named: &str,
) -> Result<Held> {
    let thread_id = conversation(named)?;
    let thread = read_index(index, move |store| {
        store.thread(thread_id).map_err(Error::from)
    })
    .await?
    .ok_or_else(|| Error::NotFound(NO_SUCH_CONVERSATION.to_owned()))?;

    if let Some(session_id) = thread.session_id {
        if thread.agent_id.as_deref() != Some(live.agent_id.as_str()) {
            return Err(Error::Validation(
                "该对话不属于当前 agent；请切回原 agent，或明确新建对话。".to_owned(),
            ));
        }
        if live.book.slot(&session_id).map_err(translate)?.is_some() {
            return Ok(Held {
                thread_id,
                session_id,
                offered: None,
                history: AgentHistory::Live,
            });
        }
        let from = read_point(index, &session_id).await?;
        live.book.open(&session_id).map_err(translate)?;
        let loaded = match live.client.load_session(session_id.clone(), from).await {
            Ok(loaded) => loaded,
            Err(cause) => {
                if let Err(cleanup) = live.book.close(&session_id) {
                    log::error!("could not release the failed session subscription: {cleanup}");
                }
                return Err(translate(cause));
            }
        };
        return Ok(Held {
            thread_id,
            session_id,
            offered: Some(loaded.selectors),
            history: AgentHistory::Loaded,
        });
    }

    let workspace = thread
        .workspace_root
        .map_or_else(|| state.root.clone(), PathBuf::from);
    let opened = live
        .client
        .new_session(workspace)
        .await
        .map_err(translate)?;
    let attached = opened.session_id.clone();
    let owner = live.agent_id.clone();
    write_index(index, move |store| {
        store
            .attach_session(thread_id, &attached, &owner)
            .map_err(Error::from)
    })
    .await?;
    Ok(Held {
        thread_id,
        session_id: opened.session_id,
        offered: Some(opened.selectors),
        history: AgentHistory::Fresh,
    })
}
