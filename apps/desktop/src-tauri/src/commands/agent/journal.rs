//! 单一帧日志管线：有界接收、批量持久化、持久化后发布。

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender, TrySendError, sync_channel};
use std::time::{Duration, Instant};

use poietica_agent_persistence_native::RecordedFrame;
use poietica_agent_runtime_native::{FrameSink, PROMPT_ADMITTED, RecordedEvent};
use serde_json::value::{RawValue, to_raw_value};
use tauri::{AppHandle, Emitter, Manager, Runtime, async_runtime};
use uuid::Uuid;

use crate::error::{Error, Result};
use crate::local_index::{LocalIndex, on_index, persistence};

use super::AGENT_EVENT;

const FRAME_INTERVAL: Duration = Duration::from_millis(16);
const FRAME_QUEUE_CAPACITY: usize = 4096;
const FRAME_BATCH_LIMIT: usize = 256;
const JOURNAL_SEND_TIMEOUT: Duration = Duration::from_secs(2);
const JOURNAL_ACK_TIMEOUT: Duration = Duration::from_secs(30);
const JOURNAL_POLL_INTERVAL: Duration = Duration::from_millis(2);
const PIPELINE_STOPPED: &str = "the frame journal stopped";
const PIPELINE_FAILED: &str = "the frame journal failed to persist accepted frames";

struct PendingFrame {
    thread: Uuid,
    event: RecordedEvent,
    committed: Option<SyncSender<bool>>,
}

enum JournalCommand {
    Frame(PendingFrame),
    Flush(SyncSender<bool>),
}

struct FrameBatch {
    thread: Uuid,
    frames: Vec<RecordedFrame>,
    committed: Vec<SyncSender<bool>>,
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

fn send_before(
    sender: &SyncSender<JournalCommand>,
    mut command: JournalCommand,
    timeout: Duration,
) -> bool {
    let deadline = Instant::now() + timeout;

    loop {
        match sender.try_send(command) {
            Ok(()) => return true,
            Err(TrySendError::Disconnected(_returned)) => return false,
            Err(TrySendError::Full(returned)) => {
                command = returned;
                let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                    return false;
                };
                std::thread::sleep(remaining.min(JOURNAL_POLL_INTERVAL));
            }
        }
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

    pub(super) fn sink(&self, thread: Uuid) -> FrameSink {
        let sender = self.sender.clone();

        Box::new(move |event| {
            let durable = event.frame.kind() == PROMPT_ADMITTED;
            let (committed, waiting) = sync_channel(0);
            let receipt = durable.then_some(committed);
            let command = JournalCommand::Frame(PendingFrame {
                thread,
                event,
                committed: receipt,
            });

            if !send_before(&sender, command, JOURNAL_SEND_TIMEOUT) {
                log::error!("{PIPELINE_STOPPED} before accepting a frame");
                return false;
            }
            if !durable {
                return true;
            }

            match waiting.recv_timeout(JOURNAL_ACK_TIMEOUT) {
                Ok(committed) => committed,
                Err(RecvTimeoutError::Timeout) => {
                    log::error!("durable frame acknowledgement timed out");
                    false
                }
                Err(RecvTimeoutError::Disconnected) => {
                    log::error!("{PIPELINE_STOPPED} before acknowledging a durable frame");
                    false
                }
            }
        })
    }

    pub(super) fn flush(&self) -> Result<()> {
        let (finished, waiting) = sync_channel(0);
        if !send_before(
            &self.sender,
            JournalCommand::Flush(finished),
            JOURNAL_SEND_TIMEOUT,
        ) {
            return Err(Error::Internal(PIPELINE_STOPPED.to_owned()));
        }

        match waiting.recv_timeout(JOURNAL_ACK_TIMEOUT) {
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
    let mut healthy = true;

    loop {
        let command = match deferred.take() {
            Some(command) => command,
            None => match receiver.recv() {
                Ok(command) => command,
                Err(_closed) => return,
            },
        };

        match command {
            JournalCommand::Flush(done) => {
                let _notified = done.send(healthy);
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

                healthy &= flush_frames(&app, pending);
                if disconnected {
                    return;
                }
            }
        }
    }
}

fn batch_index(
    batches: &mut Vec<FrameBatch>,
    indexes: &mut HashMap<(Uuid, String), usize>,
    thread: Uuid,
    session_id: &str,
) -> usize {
    let key = (thread, session_id.to_owned());
    if let Some(index) = indexes.get(&key) {
        return *index;
    }

    let index = batches.len();
    batches.push(FrameBatch {
        thread,
        frames: Vec::new(),
        committed: Vec::new(),
    });
    indexes.insert(key, index);
    index
}

fn flush_frames<R: Runtime>(app: &AppHandle<R>, pending: Vec<PendingFrame>) -> bool {
    let mut batches = Vec::new();
    let mut indexes = HashMap::new();
    let mut complete = true;

    for PendingFrame {
        thread,
        event,
        committed,
    } in pending
    {
        let frame = match to_raw_value(&event) {
            Ok(frame) => frame,
            Err(error) => {
                log::error!("a recorded frame could not be serialized: {error}");
                if let Some(receipt) = committed {
                    let _sent = receipt.send(false);
                }
                complete = false;
                continue;
            }
        };
        let index = batch_index(&mut batches, &mut indexes, thread, &event.session_id);
        let Some(batch) = batches.get_mut(index) else {
            if let Some(receipt) = committed {
                let _sent = receipt.send(false);
            }
            complete = false;
            continue;
        };
        if let Some(receipt) = committed {
            batch.committed.push(receipt);
        }
        batch.frames.push(RecordedFrame {
            session_id: event.session_id,
            seq: event.seq,
            at: event.at,
            frame,
        });
    }

    for batch in batches {
        complete &= persist_then_emit(app, batch);
    }

    complete
}

fn persist_then_emit<R: Runtime>(app: &AppHandle<R>, batch: FrameBatch) -> bool {
    let logged = Arc::new(batch.frames);
    let mut delay = Duration::from_millis(50);

    let refused = loop {
        let stored = Arc::clone(&logged);
        let thread = batch.thread;
        let result = async_runtime::block_on(async {
            let index = app.state::<LocalIndex>();
            on_index(&index, move |store| {
                store
                    .record_frames(thread, stored.as_slice())
                    .map_err(persistence)
            })
            .await
        });

        match result {
            Ok(refused) => break refused,
            Err(error) if delay <= Duration::from_millis(400) => {
                log::warn!("persist agent event batch failed; retrying: {error}");
                std::thread::sleep(delay);
                delay = delay.saturating_mul(2);
            }
            Err(error) => {
                log::error!("persist agent event batch failed permanently: {error}");
                for receipt in batch.committed {
                    let _sent = receipt.send(false);
                }
                return false;
            }
        }
    };

    if refused > 0 {
        log::error!("the frame log already contained {refused} positions");
        for receipt in batch.committed {
            let _sent = receipt.send(false);
        }
        return false;
    }

    let shown: Vec<&RawValue> = logged.iter().map(|frame| frame.frame.as_ref()).collect();
    for receipt in batch.committed {
        let _sent = receipt.send(true);
    }
    if let Err(error) = app.emit(AGENT_EVENT, &shown) {
        log::warn!("emit agent event failed after persistence: {error}");
    }

    true
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::{FrameBatch, batch_index};
    use uuid::Uuid;

    #[test]
    fn journal_groups_many_sessions_without_aliasing() {
        let mut batches: Vec<FrameBatch> = Vec::new();
        let mut indexes = HashMap::new();

        for index in 0..128_u128 {
            let thread = Uuid::from_u128(index.saturating_add(1));
            let session = format!("session-{index}");
            let first = batch_index(&mut batches, &mut indexes, thread, &session);
            let second = batch_index(&mut batches, &mut indexes, thread, &session);
            assert_eq!(first, second);
        }

        assert_eq!(batches.len(), 128);
        assert_eq!(indexes.len(), 128);
    }
}
