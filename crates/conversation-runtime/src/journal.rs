//! Bounded frame admission, commit-before-publish, and an explicitly owned worker.

use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, Mutex};
use std::thread::{JoinHandle, ThreadId};
use std::time::{Duration, Instant};

use poietica_conversation::event::EventEnvelope;
use poietica_conversation::identity::ThreadId as ConversationId;
use poietica_kap_client::translate;
use poietica_kap_client::{FrameSink, RecordedEvent};
use poietica_ledger::conversation::AppendBatch;
use poietica_ledger::execution::{IndexError, LocalIndex, write_index_worker};

const FRAME_INTERVAL: Duration = Duration::from_millis(16);
const FRAME_QUEUE_CAPACITY: usize = 4096;
const FRAME_BATCH_LIMIT: usize = 256;
const FLUSH_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, thiserror::Error)]
pub enum JournalError {
    #[error("could not start the frame journal: {0}")]
    Start(#[from] std::io::Error),
    #[error("the frame journal is closed")]
    Closed,
    #[error("the frame journal queue is full")]
    Full,
    #[error("the frame journal failed to persist accepted frames")]
    Persistence,
    #[error("the frame journal deadline expired")]
    Timeout,
    #[error("the frame journal worker panicked")]
    Panicked,
    #[error("the frame journal owner lock was poisoned")]
    Poisoned,
    #[error("the frame journal cannot wait for itself")]
    Reentrant,
}

struct PendingFrame {
    thread: uuid::Uuid,
    recorded: RecordedEvent,
}

enum JournalCommand {
    Frame(PendingFrame),
    Flush(SyncSender<bool>),
}

struct JournalOwner {
    sender: Mutex<Option<SyncSender<JournalCommand>>>,
    worker: Mutex<Option<JoinHandle<()>>>,
    worker_id: ThreadId,
    failed: Arc<AtomicBool>,
}

impl Drop for JournalOwner {
    fn drop(&mut self) {
        let sender = self
            .sender
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        drop(sender.take());
        let worker = self
            .worker
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(worker) = worker.take()
            && worker.thread().id() != std::thread::current().id()
            && worker.join().is_err()
        {
            log::error!("the frame journal panicked while releasing its owner");
        }
    }
}

#[derive(Clone)]
pub struct FrameJournal {
    owner: Arc<JournalOwner>,
}

impl fmt::Debug for FrameJournal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FrameJournal")
            .field("failed", &self.owner.failed.load(Ordering::Acquire))
            .finish_non_exhaustive()
    }
}

impl FrameJournal {
    pub fn new<E, P>(index: LocalIndex<E>, publish: P) -> Result<Self, JournalError>
    where
        E: From<IndexError> + fmt::Display + Send + 'static,
        P: Fn(String, Vec<EventEnvelope>) + Send + 'static,
    {
        Self::start(move |pending| flush_frames(&index, pending, &publish))
    }

    fn start(
        commit: impl Fn(Vec<PendingFrame>) -> bool + Send + 'static,
    ) -> Result<Self, JournalError> {
        let (sender, receiver) = sync_channel(FRAME_QUEUE_CAPACITY);
        let failed = Arc::new(AtomicBool::new(false));
        let failure = Arc::clone(&failed);
        let worker = std::thread::Builder::new()
            .name("poietica-frame-journal".to_owned())
            .spawn(move || run(receiver, failure, commit))?;
        let worker_id = worker.thread().id();
        Ok(Self {
            owner: Arc::new(JournalOwner {
                sender: Mutex::new(Some(sender)),
                worker: Mutex::new(Some(worker)),
                worker_id,
                failed,
            }),
        })
    }

    fn health(&self) -> Result<(), JournalError> {
        if self.owner.failed.load(Ordering::Acquire) {
            return Err(JournalError::Persistence);
        }
        Ok(())
    }

    pub fn check(&self) -> Result<(), JournalError> {
        self.health()?;
        if self
            .owner
            .sender
            .lock()
            .map_err(|_| JournalError::Poisoned)?
            .is_none()
        {
            return Err(JournalError::Closed);
        }
        Ok(())
    }

    fn submit(&self, command: JournalCommand) -> Result<(), JournalError> {
        self.health()?;
        let sender = self
            .owner
            .sender
            .lock()
            .map_err(|_| JournalError::Poisoned)?;
        sender
            .as_ref()
            .ok_or(JournalError::Closed)?
            .try_send(command)
            .map_err(|failure| match failure {
                TrySendError::Full(_) => JournalError::Full,
                TrySendError::Disconnected(_) => JournalError::Closed,
            })
    }

    pub fn sink(&self, thread: uuid::Uuid) -> FrameSink {
        let journal = self.clone();
        Box::new(move |recorded| {
            match journal.submit(JournalCommand::Frame(PendingFrame { thread, recorded })) {
                Ok(()) => true,
                Err(error) => {
                    log::error!("frame admission failed: {error}");
                    false
                }
            }
        })
    }

    pub fn flush(&self) -> Result<(), JournalError> {
        if self.owner.worker_id == std::thread::current().id() {
            return Err(JournalError::Reentrant);
        }
        let (done, waiting) = sync_channel(1);
        self.submit(JournalCommand::Flush(done))?;
        match waiting.recv_timeout(FLUSH_TIMEOUT) {
            Ok(true) => self.health(),
            Ok(false) => Err(JournalError::Persistence),
            Err(RecvTimeoutError::Timeout) => Err(JournalError::Timeout),
            Err(RecvTimeoutError::Disconnected) => Err(JournalError::Closed),
        }
    }

    pub fn close(&self) -> Result<(), JournalError> {
        if self.owner.worker_id == std::thread::current().id() {
            return Err(JournalError::Reentrant);
        }
        // No sender clone escapes this owner; taking it closes admission before draining.
        drop(
            self.owner
                .sender
                .lock()
                .map_err(|_| JournalError::Poisoned)?
                .take(),
        );
        let mut worker = self
            .owner
            .worker
            .lock()
            .map_err(|_| JournalError::Poisoned)?;
        let deadline = Instant::now() + FLUSH_TIMEOUT;
        while worker.as_ref().is_some_and(|held| !held.is_finished()) {
            if Instant::now() >= deadline {
                return Err(JournalError::Timeout);
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        if let Some(worker) = worker.take()
            && worker.join().is_err()
        {
            self.owner.failed.store(true, Ordering::Release);
            return Err(JournalError::Panicked);
        }
        self.health()
    }
}

#[allow(
    clippy::needless_pass_by_value,
    reason = "worker thread takes ownership; caller returns before join"
)]
fn run(
    receiver: Receiver<JournalCommand>,
    failed: Arc<AtomicBool>,
    commit: impl Fn(Vec<PendingFrame>) -> bool,
) {
    let mut deferred = None;
    loop {
        let command = match deferred.take() {
            Some(command) => command,
            None => match receiver.recv() {
                Ok(command) => command,
                Err(_) => return,
            },
        };
        match command {
            JournalCommand::Flush(done) => {
                let _notified = done.send(!failed.load(Ordering::Acquire));
            }
            JournalCommand::Frame(first) => {
                let deadline = Instant::now() + FRAME_INTERVAL;
                let mut pending = vec![first];
                let mut disconnected = false;
                while pending.len() < FRAME_BATCH_LIMIT {
                    let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                        break;
                    };
                    match receiver.recv_timeout(remaining) {
                        Ok(JournalCommand::Frame(frame)) => pending.push(frame),
                        Ok(other) => {
                            deferred = Some(other);
                            break;
                        }
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => {
                            disconnected = true;
                            break;
                        }
                    }
                }
                if !commit(pending) {
                    failed.store(true, Ordering::Release);
                }
                if disconnected {
                    return;
                }
            }
        }
    }
}

fn batch_index(
    batches: &mut Vec<AppendBatch>,
    indexes: &mut HashMap<uuid::Uuid, HashMap<String, usize>>,
    thread: uuid::Uuid,
    session_id: &str,
) -> usize {
    if let Some(index) = indexes
        .get(&thread)
        .and_then(|sessions| sessions.get(session_id))
    {
        return *index;
    }

    let index = batches.len();
    batches.push(AppendBatch {
        thread: ConversationId::new(thread.to_string()),
        session: session_id.to_owned(),
        events: Vec::new(),
    });
    indexes
        .entry(thread)
        .or_default()
        .insert(session_id.to_owned(), index);
    index
}

fn flush_frames<E, P>(index: &LocalIndex<E>, pending: Vec<PendingFrame>, publish: &P) -> bool
where
    E: From<IndexError> + fmt::Display + Send + 'static,
    P: Fn(String, Vec<EventEnvelope>),
{
    let mut batches = Vec::new();
    let mut indexes = HashMap::new();
    for PendingFrame { thread, recorded } in pending {
        let index = batch_index(&mut batches, &mut indexes, thread, &recorded.session_id);
        let Some(batch) = batches.get_mut(index) else {
            log::error!("the frame journal lost its batch index");
            return false;
        };
        batch
            .events
            .push(translate::conversation_event(recorded.frame));
    }
    batches.is_empty() || persist_then_emit(index, batches, publish)
}

fn persist_then_emit<E, P>(
    index: &LocalIndex<E>,
    mut batches: Vec<AppendBatch>,
    publish: &P,
) -> bool
where
    E: From<IndexError> + fmt::Display + Send + 'static,
    P: Fn(String, Vec<EventEnvelope>),
{
    let mut delay = Duration::from_millis(50);
    let envelopes = loop {
        let attempt = write_index_worker(index, move |store| {
            let outcome = store
                .append_batches(&mut batches)
                .map_err(|failure| failure.to_string());
            Ok::<_, E>((batches, outcome))
        });
        let (returned, outcome) = match attempt {
            Ok(attempt) => attempt,
            Err(error) => {
                log::error!("the ledger writer stopped: {error}");
                return false;
            }
        };
        batches = returned;
        match outcome {
            Ok(envelopes) => break envelopes,
            Err(error) if delay <= Duration::from_millis(400) => {
                log::warn!("persist agent event batch failed; retrying: {error}");
                std::thread::sleep(delay);
                delay = delay.saturating_mul(2);
            }
            Err(error) => {
                log::error!("persist agent event batch failed permanently: {error}");
                return false;
            }
        }
    };

    if envelopes.len() != batches.len() {
        log::error!("the ledger returned a different number of frame batches");
        return false;
    }
    for (batch, envelopes) in batches.into_iter().zip(envelopes) {
        publish(batch.session, envelopes);
    }
    true
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use poietica_ledger::conversation::AppendBatch;
    use uuid::Uuid;

    use super::batch_index;

    #[test]
    fn journal_groups_many_sessions_without_aliasing() {
        let mut batches: Vec<AppendBatch> = Vec::new();
        let mut indexes = HashMap::new();
        let thread = Uuid::from_u128(1);
        for index in 0..128_u128 {
            let session = format!("session-{index}");
            let first = batch_index(&mut batches, &mut indexes, thread, &session);
            let second = batch_index(&mut batches, &mut indexes, thread, &session);
            assert_eq!(first, second);
        }
        assert_eq!(batches.len(), 128);
        assert_eq!(indexes.len(), 1);
        assert_eq!(indexes.get(&thread).map(HashMap::len), Some(128));
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::{FrameJournal, JournalError};
    use poietica_kap_client::{RecordedEvent, RunFrame};
    use std::error::Error;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use uuid::Uuid;

    fn frame() -> RecordedEvent {
        RecordedEvent {
            session_id: "session".to_owned(),
            seq: 1,
            at: 0,
            frame: RunFrame::RunFinished {
                stop_reason: "end_turn".to_owned(),
            },
        }
    }

    #[test]
    fn close_drains_accepted_frames_and_revokes_existing_sinks() -> Result<(), Box<dyn Error>> {
        let count = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&count);
        let journal = FrameJournal::start(move |pending| {
            observed.fetch_add(pending.len(), Ordering::SeqCst);
            true
        })?;
        let mut sink = journal.sink(Uuid::from_u128(1));
        assert!(sink(frame()));
        journal.close()?;
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert!(!sink(frame()));
        journal.close()?;
        Ok(())
    }

    #[test]
    fn later_flushes_cannot_erase_a_persistence_failure() -> Result<(), Box<dyn Error>> {
        let journal = FrameJournal::start(|_| false)?;
        let mut sink = journal.sink(Uuid::from_u128(1));
        assert!(sink(frame()));
        assert!(matches!(journal.flush(), Err(JournalError::Persistence)));
        assert!(matches!(journal.flush(), Err(JournalError::Persistence)));
        assert!(matches!(journal.close(), Err(JournalError::Persistence)));
        assert!(!sink(frame()));
        Ok(())
    }
}
