//! Owns bounded SQLite execution lanes. Accepted writes outlive a dropped response waiter.

use std::fmt;
use std::marker::PhantomData;
use std::path::Path;
use std::sync::Arc;
use std::thread::{self, JoinHandle};

use poietica_time::WallClock;
use thiserror::Error;
use tokio::sync::{mpsc, oneshot};

use crate::LedgerError;
use crate::index::AgentStore;

const QUEUE_CAPACITY: usize = 256;
type IndexJob = Box<dyn FnOnce(&mut AgentStore) + Send + 'static>;

#[derive(Debug, Error)]
pub enum IndexError {
    #[error(transparent)]
    Storage(#[from] LedgerError),
    #[error("could not start the local index worker: {0}")]
    Start(#[from] std::io::Error),
    #[error("the local index actor stopped")]
    Stopped,
    #[error("the local index actor dropped a response")]
    ResponseDropped,
    #[error("an index job cannot synchronously call its own execution lane")]
    Reentrant,
}

struct IndexActor {
    label: &'static str,
    sender: Option<mpsc::Sender<IndexJob>>,
    worker: Option<JoinHandle<()>>,
}

impl fmt::Debug for IndexActor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IndexActor")
            .field("label", &self.label)
            .finish_non_exhaustive()
    }
}

impl IndexActor {
    fn start(label: &'static str, mut store: AgentStore) -> Result<Self, IndexError> {
        let (sender, mut receiver) = mpsc::channel::<IndexJob>(QUEUE_CAPACITY);
        let worker = thread::Builder::new()
            .name(label.to_owned())
            .spawn(move || {
                while let Some(job) = receiver.blocking_recv() {
                    job(&mut store);
                }
            })?;
        Ok(Self {
            label,
            sender: Some(sender),
            worker: Some(worker),
        })
    }

    fn sender(&self) -> Result<&mpsc::Sender<IndexJob>, IndexError> {
        if self
            .worker
            .as_ref()
            .is_some_and(|worker| worker.thread().id() == thread::current().id())
        {
            return Err(IndexError::Reentrant);
        }
        self.sender.as_ref().ok_or(IndexError::Stopped)
    }

    async fn send(&self, job: IndexJob) -> Result<(), IndexError> {
        self.sender()?
            .send(job)
            .await
            .map_err(|_| IndexError::Stopped)
    }

    fn call<T, F, E>(&self, work: F) -> Result<T, E>
    where
        T: Send + 'static,
        E: From<IndexError> + Send + 'static,
        F: FnOnce(&mut AgentStore) -> Result<T, E> + Send + 'static,
    {
        let (reply, answer) = oneshot::channel();
        self.sender()
            .map_err(E::from)?
            .blocking_send(Box::new(move |store| {
                let _sent = reply.send(work(store));
            }))
            .map_err(|_| E::from(IndexError::Stopped))?;
        answer
            .blocking_recv()
            .map_err(|_| E::from(IndexError::ResponseDropped))?
    }
}

impl Drop for IndexActor {
    fn drop(&mut self) {
        self.sender.take();
        let Some(worker) = self.worker.take() else {
            return;
        };
        if worker.thread().id() == thread::current().id() {
            return;
        }
        if worker.join().is_err() {
            log::error!("{} panicked while stopping", self.label);
        }
    }
}

#[derive(Debug)]
struct IndexActors {
    reader: IndexActor,
    background_reader: IndexActor,
    writer: IndexActor,
}

#[derive(Debug)]
pub struct LocalIndex<E = IndexError> {
    actors: Arc<IndexActors>,
    error: PhantomData<fn() -> E>,
}

impl<E> Clone for LocalIndex<E> {
    fn clone(&self) -> Self {
        Self {
            actors: Arc::clone(&self.actors),
            error: PhantomData,
        }
    }
}

impl<E> LocalIndex<E> {
    pub fn open(path: &Path, clock: impl WallClock + Clone + 'static) -> Result<Self, IndexError> {
        let writer = AgentStore::open(path, clock.clone())?;
        let reader = AgentStore::open_read_only(path, clock.clone())?;
        let background_reader = AgentStore::open_read_only(path, clock)?;
        Ok(Self {
            error: PhantomData,
            actors: Arc::new(IndexActors {
                reader: IndexActor::start("poietica-ledger-reader", reader)?,
                background_reader: IndexActor::start(
                    "poietica-ledger-background-reader",
                    background_reader,
                )?,
                writer: IndexActor::start("poietica-ledger-writer", writer)?,
            }),
        })
    }
}

async fn dispatch<T, F, E>(actor: &IndexActor, work: F) -> Result<T, E>
where
    T: Send + 'static,
    E: From<IndexError> + Send + 'static,
    F: FnOnce(&mut AgentStore) -> Result<T, E> + Send + 'static,
{
    let (reply, answer) = oneshot::channel();
    actor
        .send(Box::new(move |store| {
            let _sent = reply.send(work(store));
        }))
        .await
        .map_err(E::from)?;
    answer
        .await
        .map_err(|_| E::from(IndexError::ResponseDropped))?
}

pub async fn read_index<T, F, E>(index: &LocalIndex<E>, work: F) -> Result<T, E>
where
    T: Send + 'static,
    E: From<IndexError> + Send + 'static,
    F: FnOnce(&mut AgentStore) -> Result<T, E> + Send + 'static,
{
    dispatch(&index.actors.reader, work).await
}

pub async fn read_index_background<T, F, E>(index: &LocalIndex<E>, work: F) -> Result<T, E>
where
    T: Send + 'static,
    E: From<IndexError> + Send + 'static,
    F: FnOnce(&mut AgentStore) -> Result<T, E> + Send + 'static,
{
    dispatch(&index.actors.background_reader, work).await
}

pub async fn write_index<T, F, E>(index: &LocalIndex<E>, work: F) -> Result<T, E>
where
    T: Send + 'static,
    E: From<IndexError> + Send + 'static,
    F: FnOnce(&mut AgentStore) -> Result<T, E> + Send + 'static,
{
    dispatch(&index.actors.writer, work).await
}

/// Blocking entry for dedicated workers, never for an async executor thread.
pub fn write_index_worker<T, F, E>(index: &LocalIndex<E>, work: F) -> Result<T, E>
where
    T: Send + 'static,
    E: From<IndexError> + Send + 'static,
    F: FnOnce(&mut AgentStore) -> Result<T, E> + Send + 'static,
{
    index.actors.writer.call(work)
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        reason = "failed execution fixtures must fail the test"
    )]
    use super::{IndexError, LocalIndex, read_index, write_index, write_index_worker};
    use poietica_time::wall_clock::SystemWallClock;

    #[test]
    fn lanes_have_independent_connection_owners() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let index = LocalIndex::<IndexError>::open(
            &directory.path().join("index.sqlite3"),
            SystemWallClock,
        )
        .expect("index");
        let owner = |_store: &mut crate::index::AgentStore| {
            Ok::<_, IndexError>(std::thread::current().id())
        };
        let reader = index.actors.reader.call(owner).expect("reader");
        let background = index
            .actors
            .background_reader
            .call(owner)
            .expect("background");
        let writer = index.actors.writer.call(owner).expect("writer");
        assert_ne!(reader, background);
        assert_ne!(reader, writer);
        assert_ne!(writer, background);
    }

    #[test]
    fn reentrant_writer_fails_instead_of_deadlocking() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let index = LocalIndex::<IndexError>::open(
            &directory.path().join("index.sqlite3"),
            SystemWallClock,
        )
        .expect("index");
        let nested = index.clone();
        let result = write_index_worker(&index, move |_store| {
            write_index_worker(&nested, |_store| Ok::<_, IndexError>(()))
        });
        assert!(matches!(result, Err(IndexError::Reentrant)));
    }

    #[tokio::test]
    async fn writes_are_visible_and_read_lanes_cannot_write() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let index = LocalIndex::<IndexError>::open(
            &directory.path().join("index.sqlite3"),
            SystemWallClock,
        )
        .expect("index");
        write_index(&index, |store| {
            store
                .set_workbench_session("saved")
                .map_err(IndexError::from)
        })
        .await
        .expect("write");
        let saved = read_index(&index, |store| {
            store.workbench_session().map_err(IndexError::from)
        })
        .await
        .expect("read");
        assert_eq!(saved.as_deref(), Some("saved"));
        let rejected = read_index(&index, |store| {
            store
                .set_workbench_session("forbidden")
                .map_err(IndexError::from)
        })
        .await;
        assert!(rejected.is_err());
    }

    #[tokio::test]
    async fn an_accepted_write_survives_a_dropped_response_waiter() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let index = LocalIndex::<IndexError>::open(
            &directory.path().join("index.sqlite3"),
            SystemWallClock,
        )
        .expect("index");
        let (reply, answer) = tokio::sync::oneshot::channel();
        drop(answer);
        index
            .actors
            .writer
            .send(Box::new(move |store| {
                let result = store
                    .set_workbench_session("accepted")
                    .map_err(IndexError::from);
                let _sent = reply.send(result);
            }))
            .await
            .expect("accepted job");
        let saved = write_index(&index, |store| {
            store.workbench_session().map_err(IndexError::from)
        })
        .await
        .expect("writer barrier");
        assert_eq!(saved.as_deref(), Some("accepted"));
    }
}
