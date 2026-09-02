//! 应用账本的执行边界：一个 writer actor，一个独立只读 actor。

use std::fmt;
use std::path::Path;
use std::sync::Arc;
use std::sync::mpsc::{Sender, channel, sync_channel};
use std::thread::{self, JoinHandle};

use poietica_ledger::LedgerError;
use poietica_ledger::index::AgentStore;
use poietica_time::WallClock;
use uuid::Uuid;

use crate::error::{Error, Result};

const ACTOR_STOPPED: &str = "the local index actor stopped";
const RESPONSE_DROPPED: &str = "the local index actor dropped a response";
const COUNT_TOO_LARGE: &str = "a stored count does not fit the wire";

type IndexJob = Box<dyn FnOnce(&mut AgentStore) + Send + 'static>;

struct IndexActor {
    label: &'static str,
    sender: Option<Sender<IndexJob>>,
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
    fn start(label: &'static str, mut store: AgentStore) -> Result<Self> {
        let (sender, receiver) = channel::<IndexJob>();
        let worker = thread::Builder::new()
            .name(label.to_owned())
            .spawn(move || {
                while let Ok(job) = receiver.recv() {
                    job(&mut store);
                }
            })
            .map_err(|error| Error::Internal(format!("could not start {label}: {error}")))?;

        Ok(Self {
            label,
            sender: Some(sender),
            worker: Some(worker),
        })
    }

    fn send(&self, job: IndexJob) -> Result<()> {
        self.sender
            .as_ref()
            .ok_or_else(|| Error::Internal(ACTOR_STOPPED.to_owned()))?
            .send(job)
            .map_err(|_closed| Error::Internal(ACTOR_STOPPED.to_owned()))
    }

    fn call<T, F>(&self, work: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut AgentStore) -> Result<T> + Send + 'static,
    {
        let (reply, answer) = sync_channel(1);
        self.send(Box::new(move |store| {
            let _sent = reply.send(work(store));
        }))?;
        answer
            .recv()
            .map_err(|_closed| Error::Internal(RESPONSE_DROPPED.to_owned()))?
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
    writer: IndexActor,
}

#[derive(Clone)]
pub struct LocalIndex {
    actors: Arc<IndexActors>,
}

impl fmt::Debug for LocalIndex {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("LocalIndex").finish_non_exhaustive()
    }
}

impl LocalIndex {
    pub fn open(path: &Path, clock: impl WallClock + Clone + 'static) -> Result<Self> {
        let writer = AgentStore::open(path, clock.clone()).map_err(persistence)?;
        let reader = AgentStore::open_read_only(path, clock).map_err(persistence)?;

        Ok(Self {
            actors: Arc::new(IndexActors {
                reader: IndexActor::start("poietica-ledger-reader", reader)?,
                writer: IndexActor::start("poietica-ledger-writer", writer)?,
            }),
        })
    }
}

async fn dispatch<T, F>(actor: &IndexActor, work: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&mut AgentStore) -> Result<T> + Send + 'static,
{
    let (reply, answer) = tokio::sync::oneshot::channel();
    actor.send(Box::new(move |store| {
        let _sent = reply.send(work(store));
    }))?;
    answer
        .await
        .map_err(|_closed| Error::Internal(RESPONSE_DROPPED.to_owned()))?
}

pub async fn read_index<T, F>(index: &LocalIndex, work: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&mut AgentStore) -> Result<T> + Send + 'static,
{
    dispatch(&index.actors.reader, work).await
}

pub async fn write_index<T, F>(index: &LocalIndex, work: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&mut AgentStore) -> Result<T> + Send + 'static,
{
    dispatch(&index.actors.writer, work).await
}

pub(crate) fn write_index_worker<T, F>(index: &LocalIndex, work: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&mut AgentStore) -> Result<T> + Send + 'static,
{
    index.actors.writer.call(work)
}

pub fn persistence(error: LedgerError) -> Error {
    log::error!("the local index rejected a statement: {error}");
    Error::Persistence(error.to_string())
}

pub fn counted(value: i64) -> Result<u32> {
    u32::try_from(value).map_err(|_overflow| Error::Internal(COUNT_TOO_LARGE.to_owned()))
}

pub fn conversation(named: &str) -> Result<Uuid> {
    Uuid::parse_str(named).map_err(|_invalid| {
        Error::Validation("the conversation identifier is not a UUID".to_owned())
    })
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        reason = "a failed actor fixture must fail the test"
    )]

    use std::fs::remove_file;
    use std::thread;

    use poietica_time::wall_clock::SystemWallClock;
    use uuid::Uuid;

    use super::LocalIndex;

    #[test]
    fn reads_and_writes_have_distinct_owners() {
        let path = std::env::temp_dir().join(format!("poietica-{}.sqlite3", Uuid::now_v7()));
        let index = LocalIndex::open(&path, SystemWallClock).expect("index");
        let reader = index
            .actors
            .reader
            .call(|_store| Ok(thread::current().id()))
            .expect("reader");
        let writer = index
            .actors
            .writer
            .call(|_store| Ok(thread::current().id()))
            .expect("writer");

        assert_ne!(reader, writer);
        drop(index);
        for suffix in ["", "-wal", "-shm"] {
            let _removed = remove_file(format!("{}{suffix}", path.display()));
        }
    }
}
