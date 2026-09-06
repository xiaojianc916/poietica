//! SQLite owns identity; a returned lease serializes the complete local session operation.

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
    #[error("the conversation has no bound agent session")]
    Unbound,
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
pub(crate) struct Held {
    pub(crate) thread_id: Uuid,
    pub(crate) session_id: String,
    pub(crate) offered: Option<Vec<ConfigControl>>,
    pub(crate) history: SessionHistory,
    _lease: tokio::sync::OwnedMutexGuard<()>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SessionMode {
    CreateIfUnbound,
    RequireBound,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct SessionRequest<'a> {
    pub(crate) owner: &'a str,
    pub(crate) default_root: &'a Path,
    pub(crate) named: &'a str,
    pub(crate) mode: SessionMode,
}

#[derive(Debug, Default)]
pub(crate) struct SessionResolver {
    lanes: Mutex<HashMap<Uuid, Weak<Mutex<()>>>>,
}

impl SessionResolver {
    /// Acquires the same lane without creating or loading a remote session.
    pub(crate) async fn exclusive(&self, thread: Uuid) -> tokio::sync::OwnedMutexGuard<()> {
        self.lane(thread).await.lock_owned().await
    }

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

    pub(crate) async fn resolve<E>(
        &self,
        index: &LocalIndex<E>,
        client: &AgentClient,
        book: &SessionBook,
        request: SessionRequest<'_>,
    ) -> Result<Held, SessionError<E>>
    where
        E: Error + From<IndexError> + Send + 'static,
    {
        let SessionRequest {
            owner,
            default_root,
            named,
            mode,
        } = request;
        let thread_id = Uuid::parse_str(named).map_err(|_| SessionError::InvalidId)?;
        let lease = self.exclusive(thread_id).await;
        let thread = read_index(index, move |store| {
            store
                .thread(thread_id)
                .map_err(IndexError::from)
                .map_err(E::from)
        })
        .await
        .map_err(SessionError::Catalog)?
        .ok_or(SessionError::Missing)?;

        if let Some(session_id) = bound_session(&thread, owner)? {
            if book.slot(&session_id)?.is_some() {
                return Ok(Held {
                    thread_id,
                    session_id,
                    offered: None,
                    history: SessionHistory::Live,
                    _lease: lease,
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
                _lease: lease,
            });
        }

        if mode == SessionMode::RequireBound {
            return Err(SessionError::Unbound);
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
            _lease: lease,
        })
    }
}

pub(crate) async fn read_point<E>(
    index: &LocalIndex<E>,
    session_id: &str,
) -> Result<Option<Cursor>, E>
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

pub(crate) fn bound_session<E: Error + 'static>(
    thread: &poietica_ledger::index::ThreadSummary,
    owner: &str,
) -> Result<Option<String>, SessionError<E>> {
    match (thread.session_id.as_deref(), thread.agent_id.as_deref()) {
        (None, None) => Ok(None),
        (Some(session), Some(agent)) if agent == owner => Ok(Some(session.to_owned())),
        _ => Err(SessionError::WrongOwner),
    }
}

// Identity is immutable once attached; control must not queue behind admission.
pub(crate) async fn address<E>(
    index: &LocalIndex<E>,
    named: &str,
    owner: &str,
) -> Result<Option<String>, SessionError<E>>
where
    E: Error + From<IndexError> + Send + 'static,
{
    let id = Uuid::parse_str(named).map_err(|_| SessionError::InvalidId)?;
    let thread = read_index(index, move |store| {
        store.thread(id).map_err(IndexError::from).map_err(E::from)
    })
    .await
    .map_err(SessionError::Catalog)?;
    match thread {
        Some(thread) => bound_session(&thread, owner),
        None => Ok(None),
    }
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

#[cfg(test)]
mod operation_ownership_tests {
    use super::{Held, SessionHistory, SessionResolver};
    use std::sync::Arc;
    use std::time::Duration;
    use uuid::Uuid;

    #[tokio::test]
    async fn the_returned_value_owns_the_operation_lane() {
        let resolver = SessionResolver::default();
        let thread = Uuid::from_u128(1);
        let lane = resolver.lane(thread).await;
        let held = Held {
            thread_id: thread,
            session_id: "session".to_owned(),
            offered: None,
            history: SessionHistory::Live,
            _lease: resolver.exclusive(thread).await,
        };
        assert!(lane.try_lock().is_err());
        drop(held);
        assert!(lane.try_lock().is_ok());
    }

    #[tokio::test]
    async fn cancelling_a_waiter_does_not_release_the_owner()
    -> Result<(), Box<dyn std::error::Error>> {
        let resolver = Arc::new(SessionResolver::default());
        let thread = Uuid::from_u128(2);
        let held = resolver.exclusive(thread).await;
        let waiter = {
            let resolver = Arc::clone(&resolver);
            tokio::spawn(async move { resolver.exclusive(thread).await })
        };
        tokio::task::yield_now().await;
        waiter.abort();
        assert!(waiter.await.is_err());
        let lane = resolver.lane(thread).await;
        assert!(lane.try_lock().is_err());
        drop(held);
        let next = tokio::time::timeout(Duration::from_secs(1), resolver.exclusive(thread)).await?;
        drop(next);
        Ok(())
    }
}

#[cfg(test)]
mod address_tests {
    use super::{SessionError, SessionResolver, address};
    use poietica_ledger::execution::{IndexError, LocalIndex, read_index, write_index};
    use poietica_time::wall_clock::SystemWallClock;
    use std::{error::Error, time::Duration};
    use uuid::Uuid;

    #[tokio::test]
    async fn control_reads_do_not_acquire_the_prompt_lane_or_create_a_binding()
    -> Result<(), Box<dyn Error>> {
        let directory = tempfile::tempdir()?;
        let index =
            LocalIndex::<IndexError>::open(&directory.path().join("index.db"), SystemWallClock)?;
        let id = Uuid::new_v4();
        write_index(&index, move |store| {
            store
                .create_thread(id, "conversation", None)
                .map_err(IndexError::from)
        })
        .await?;
        let resolver = SessionResolver::default();
        let lease = resolver.exclusive(id).await;
        let absent = tokio::time::timeout(
            Duration::from_secs(2),
            address(&index, &id.to_string(), "agent"),
        )
        .await??;
        assert!(absent.is_none());
        write_index(&index, move |store| {
            store
                .attach_session(id, "session", "agent")
                .map_err(IndexError::from)
        })
        .await?;
        assert_eq!(
            address(&index, &id.to_string(), "agent").await?.as_deref(),
            Some("session")
        );
        assert!(matches!(
            address(&index, &id.to_string(), "another").await,
            Err(SessionError::WrongOwner)
        ));
        let stored = read_index(&index, move |store| {
            store.thread(id).map_err(IndexError::from)
        })
        .await?;
        assert_eq!(
            stored.and_then(|thread| thread.session_id).as_deref(),
            Some("session")
        );
        drop(lease);
        Ok(())
    }
}
