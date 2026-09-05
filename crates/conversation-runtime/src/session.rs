//! SQLite owns identity; the resolver only serializes each identity's acquisition.

use std::collections::HashMap;
use std::error::Error;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};

use poietica_kap_client::{AgentClient, ConfigControl, Cursor, KapError, SessionBook};
use poietica_ledger::execution::{IndexError, LocalIndex, read_index, write_index};
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum SessionError<E: Error + 'static> {
    #[error("session catalog failed: {0}")]
    Catalog(#[source] E),
    #[error("the conversation identifier is invalid")]
    InvalidId,
    #[error("that conversation no longer exists")]
    Missing,
    #[error("the conversation belongs to another agent")]
    WrongOwner,
    #[error(transparent)]
    Agent(#[from] KapError),
    #[error("restoring the session failed: {cause}; releasing its subscription failed: {cleanup}")]
    RestoreCleanup {
        #[source]
        cause: KapError,
        cleanup: KapError,
    },
    #[error("binding the session failed: {cause}; archiving the unbound session failed: {cleanup}")]
    AttachCleanup {
        #[source]
        cause: E,
        cleanup: KapError,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionHistory {
    Fresh,
    Loaded,
    Live,
}

#[derive(Debug)]
pub struct Held {
    pub thread_id: Uuid,
    pub session_id: String,
    pub offered: Option<Vec<ConfigControl>>,
    pub history: SessionHistory,
}

#[derive(Debug, Default)]
pub struct SessionResolver {
    lanes: Mutex<HashMap<Uuid, Weak<Mutex<()>>>>,
}

impl SessionResolver {
    async fn lane(&self, thread: Uuid) -> Arc<Mutex<()>> {
        let mut lanes = self.lanes.lock().await;
        lanes.retain(|_, lane| lane.strong_count() > 0);
        if let Some(held) = lanes.get(&thread).and_then(Weak::upgrade) {
            return held;
        }
        let held = Arc::new(Mutex::new(()));
        lanes.insert(thread, Arc::downgrade(&held));
        held
    }

    pub async fn resolve<E>(
        &self,
        index: &LocalIndex<E>,
        client: &AgentClient,
        book: &SessionBook,
        owner: &str,
        default_root: &Path,
        named: &str,
    ) -> Result<Held, SessionError<E>>
    where
        E: Error + From<IndexError> + Send + 'static,
    {
        let thread_id = Uuid::parse_str(named).map_err(|_| SessionError::InvalidId)?;
        let lane = self.lane(thread_id).await;
        let _held = lane.lock().await;
        let thread = read_index(index, move |store| {
            store
                .thread(thread_id)
                .map_err(IndexError::from)
                .map_err(E::from)
        })
        .await
        .map_err(SessionError::Catalog)?
        .ok_or(SessionError::Missing)?;

        if let Some(session_id) = thread.session_id {
            if thread.agent_id.as_deref() != Some(owner) {
                return Err(SessionError::WrongOwner);
            }
            if book.slot(&session_id)?.is_some() {
                return Ok(Held {
                    thread_id,
                    session_id,
                    offered: None,
                    history: SessionHistory::Live,
                });
            }
            let from = read_point(index, &session_id)
                .await
                .map_err(SessionError::Catalog)?;
            book.open(&session_id)?;
            let loaded = match client.load_session(session_id.clone(), from).await {
                Ok(loaded) => loaded,
                Err(cause) => {
                    if let Err(cleanup) = book.close(&session_id) {
                        return Err(SessionError::RestoreCleanup { cause, cleanup });
                    }
                    return Err(cause.into());
                }
            };
            return Ok(Held {
                thread_id,
                session_id,
                offered: Some(loaded.selectors),
                history: SessionHistory::Loaded,
            });
        }

        let workspace = thread
            .workspace_root
            .map_or_else(|| default_root.to_path_buf(), PathBuf::from);
        let opened = client.new_session(workspace).await?;
        let attached = opened.session_id.clone();
        let agent = owner.to_owned();
        let binding = write_index(index, move |store| {
            store
                .attach_session(thread_id, &attached, &agent)
                .map_err(IndexError::from)
                .map_err(E::from)
        })
        .await;
        if let Err(cause) = binding {
            // Only this acquisition's unbound session may be compensated.
            if let Err(cleanup) = client.delete_session(opened.session_id.clone()).await {
                return Err(SessionError::AttachCleanup { cause, cleanup });
            }
            return Err(SessionError::Catalog(cause));
        }
        Ok(Held {
            thread_id,
            session_id: opened.session_id,
            offered: Some(opened.selectors),
            history: SessionHistory::Fresh,
        })
    }
}

pub async fn read_point<E>(index: &LocalIndex<E>, session_id: &str) -> Result<Option<Cursor>, E>
where
    E: From<IndexError> + Send + 'static,
{
    let asked = session_id.to_owned();
    let stored = read_index(index, move |store| {
        store
            .cursor_of(&asked)
            .map_err(IndexError::from)
            .map_err(E::from)
    })
    .await?;
    Ok(stored.map(|read| Cursor {
        seq: read.seq,
        epoch: read.epoch,
    }))
}

#[cfg(test)]
mod tests {
    use super::SessionResolver;
    use std::sync::Arc;
    use uuid::Uuid;

    #[tokio::test]
    async fn the_same_identity_shares_a_lane_and_others_do_not() {
        let resolver = SessionResolver::default();
        let id = Uuid::from_u128(1);
        let first = resolver.lane(id).await;
        let second = resolver.lane(id).await;
        let independent = resolver.lane(Uuid::from_u128(2)).await;
        assert!(Arc::ptr_eq(&first, &second));
        assert!(!Arc::ptr_eq(&first, &independent));
        let held = first.lock().await;
        assert!(second.try_lock().is_err());
        assert!(independent.try_lock().is_ok());
        drop(held);
        assert!(second.try_lock().is_ok());
    }

    #[tokio::test]
    async fn unused_lanes_do_not_retain_session_state() {
        let resolver = SessionResolver::default();
        for value in 1..100 {
            drop(resolver.lane(Uuid::from_u128(value)).await);
        }
        let held = resolver.lane(Uuid::from_u128(100)).await;
        assert_eq!(resolver.lanes.lock().await.len(), 1);
        drop(held);
    }
}
