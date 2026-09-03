//! 单一事件管线：非阻塞接收、批量落账、提交后发布。

use std::collections::HashMap;
use std::fmt;
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender, TrySendError, sync_channel};
use std::time::{Duration, Instant};

use poietica_conversation::identity::ThreadId;
use poietica_kap_client::translate;
use poietica_kap_client::{FrameSink, RecordedEvent};
use poietica_ledger::conversation::AppendBatch;
use tauri::{AppHandle, Manager, Runtime};
use tauri_specta::Event as _;

use crate::error::{Error, Result};
use crate::ipc::commands::ledger::local_index::{LocalIndex, write_index_worker};

use super::dto::{AgentRunBatch, AgentRunEvent};

const FRAME_INTERVAL: Duration = Duration::from_millis(16);
const FRAME_QUEUE_CAPACITY: usize = 4096;
const FRAME_BATCH_LIMIT: usize = 256;
const FLUSH_TIMEOUT: Duration = Duration::from_secs(5);
const PIPELINE_STOPPED: &str = "the frame journal stopped";
const PIPELINE_FAILED: &str = "the frame journal failed to persist accepted frames";
const PIPELINE_BEHIND: &str = "the frame journal is too far behind to flush";

struct PendingFrame {
    thread: uuid::Uuid,
    recorded: RecordedEvent,
}

enum JournalCommand {
    Frame(PendingFrame),
    Flush(SyncSender<bool>),
}

#[derive(Clone)]
pub(super) struct FrameJournal {
    sender: SyncSender<JournalCommand>,
}

impl fmt::Debug for FrameJournal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FrameJournal")
            .finish_non_exhaustive()
    }
}

impl FrameJournal {
    pub(super) fn new<R: Runtime>(app: &AppHandle<R>) -> Result<Self> {
        let (sender, receiver) = sync_channel(FRAME_QUEUE_CAPACITY);
        let worker = app.clone();
        let _journal = std::thread::Builder::new()
            .name("poietica-frame-journal".to_owned())
            .spawn(move || run(worker, receiver))
            .map_err(|error| {
                Error::Internal(format!("could not start the frame journal: {error}"))
            })?;
        Ok(Self { sender })
    }

    pub(super) fn sink(&self, thread: uuid::Uuid) -> FrameSink {
        let sender = self.sender.clone();
        Box::new(move |event| {
            match sender.try_send(JournalCommand::Frame(PendingFrame {
                thread,
                recorded: event,
            })) {
                Ok(()) => true,
                Err(TrySendError::Full(_)) => {
                    log::error!("the frame journal is {FRAME_QUEUE_CAPACITY} frames behind");
                    false
                }
                Err(TrySendError::Disconnected(_)) => {
                    log::error!("{PIPELINE_STOPPED} before accepting a frame");
                    false
                }
            }
        })
    }

    pub(super) fn flush(&self) -> Result<()> {
        let (finished, waiting) = sync_channel(0);
        self.sender
            .try_send(JournalCommand::Flush(finished))
            .map_err(|refused| match refused {
                TrySendError::Full(_) => Error::Internal(PIPELINE_BEHIND.to_owned()),
                TrySendError::Disconnected(_) => Error::Internal(PIPELINE_STOPPED.to_owned()),
            })?;
        match waiting.recv_timeout(FLUSH_TIMEOUT) {
            Ok(true) => Ok(()),
            Ok(false) => Err(Error::Internal(PIPELINE_FAILED.to_owned())),
            Err(RecvTimeoutError::Timeout) => Err(Error::Internal(
                "the frame journal flush timed out".to_owned(),
            )),
            Err(RecvTimeoutError::Disconnected) => {
                Err(Error::Internal(PIPELINE_STOPPED.to_owned()))
            }
        }
    }
}

fn run<R: Runtime>(app: AppHandle<R>, receiver: Receiver<JournalCommand>) {
    let mut deferred = None;
    let mut unreported = 0_usize;
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
                let _notified = done.send(unreported == 0);
                unreported = 0;
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
                if !flush_frames(&app, pending) {
                    unreported = unreported.saturating_add(1);
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
        thread: ThreadId::new(thread.to_string()),
        session: session_id.to_owned(),
        events: Vec::new(),
    });
    indexes
        .entry(thread)
        .or_default()
        .insert(session_id.to_owned(), index);
    index
}

fn flush_frames<R: Runtime>(app: &AppHandle<R>, pending: Vec<PendingFrame>) -> bool {
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
    batches.is_empty() || persist_then_emit(app, batches)
}

fn persist_then_emit<R: Runtime>(app: &AppHandle<R>, mut batches: Vec<AppendBatch>) -> bool {
    let mut delay = Duration::from_millis(50);
    let envelopes = loop {
        let index = app.state::<LocalIndex>();
        let attempt = write_index_worker(&index, move |store| {
            let outcome = store
                .append_batches(&mut batches)
                .map_err(|failure| Error::Internal(failure.to_string()));
            Ok((batches, outcome))
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
        let events = envelopes.into_iter().map(AgentRunEvent::from).collect();
        if let Err(error) = (AgentRunBatch {
            session_id: batch.session,
            events,
        })
        .emit(app)
        {
            log::warn!("emit agent event failed after persistence: {error}");
        }
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
