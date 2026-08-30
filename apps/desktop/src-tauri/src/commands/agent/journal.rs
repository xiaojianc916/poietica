//! 单一事件管线：非阻塞接收、批量落账、落账后发布。
//!
//! 收帧那一步在 RunSlot 的锁内、驱动器的单线程运行时里被调用，所以它只许入队
//! 或拒收：睡一下或等一个回执，停住的是整条 WS 链路。
//!
//! 事件以领域联合（ConversationEvent）落 `conversation_events` —— 屏幕那条
//! 经过的唯一账本；发布给界面的形状与旧帧账逐字节一致（sessionId/seq/at 由
//! 信封并回载荷），所以重放与实时是同一串字节。

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender, TrySendError, sync_channel};
use std::time::{Duration, Instant};

use poietica_agent_runtime_native::translate;
use poietica_agent_runtime_native::{FrameSink, RecordedEvent};
use poietica_conversation::event::ConversationEvent;
use poietica_conversation::ports::ConversationLedger;
use tauri::{AppHandle, Emitter, Manager, Runtime, async_runtime};

use crate::error::{Error, Result};
use crate::local_index::{LocalIndex, on_index};

use super::AGENT_EVENT;

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

struct FrameBatch {
    thread: uuid::Uuid,
    session: String,
    events: Vec<ConversationEvent>,
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

    /// 收帧：入队即答。拒收只有两种事实 —— 管线没了，或积压到顶。
    pub(super) fn sink(&self, thread: uuid::Uuid) -> FrameSink {
        let sender = self.sender.clone();

        Box::new(move |event| {
            match sender.try_send(JournalCommand::Frame(PendingFrame {
                thread,
                recorded: event,
            })) {
                Ok(()) => true,
                Err(TrySendError::Full(_refused)) => {
                    log::error!("the frame journal is {FRAME_QUEUE_CAPACITY} frames behind");
                    false
                }
                Err(TrySendError::Disconnected(_refused)) => {
                    log::error!("{PIPELINE_STOPPED} before accepting a frame");
                    false
                }
            }
        })
    }

    /// 退场前的收账：报出这条管线有没有咽下过落账失败。
    ///
    /// 它是唯一还会等的地方，所以调用它的命令必须是 async 的 —— 同步命令跑在
    /// 主线程上（见 turn.rs 的 agent_shutdown）。
    pub(super) fn flush(&self) -> Result<()> {
        let (finished, waiting) = sync_channel(0);
        self.sender
            .try_send(JournalCommand::Flush(finished))
            .map_err(|refused| match refused {
                TrySendError::Full(_dropped) => Error::Internal(PIPELINE_BEHIND.to_owned()),
                TrySendError::Disconnected(_dropped) => {
                    Error::Internal(PIPELINE_STOPPED.to_owned())
                }
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
    /* 还没报出去的落账失败笔数。报一次清一次：一批失败是那一批的事实，不是这条
    管线余生的事实 —— 常驻的假会让 disconnect 与换 agent 从此永远失败。 */
    let mut unreported = 0_usize;

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
    batches: &mut Vec<FrameBatch>,
    indexes: &mut HashMap<(uuid::Uuid, String), usize>,
    thread: uuid::Uuid,
    session_id: &str,
) -> usize {
    let key = (thread, session_id.to_owned());
    if let Some(index) = indexes.get(&key) {
        return *index;
    }

    let index = batches.len();
    batches.push(FrameBatch {
        thread,
        session: session_id.to_owned(),
        events: Vec::new(),
    });
    indexes.insert(key, index);
    index
}

fn flush_frames<R: Runtime>(app: &AppHandle<R>, pending: Vec<PendingFrame>) -> bool {
    let mut batches = Vec::new();
    let mut indexes = HashMap::new();
    let mut complete = true;

    for PendingFrame { thread, recorded } in pending {
        let index = batch_index(&mut batches, &mut indexes, thread, &recorded.session_id);
        let Some(batch) = batches.get_mut(index) else {
            complete = false;
            continue;
        };
        batch
            .events
            .push(translate::conversation_event(&recorded.frame));
    }

    for batch in batches {
        complete &= persist_then_emit(app, batch);
    }

    complete
}

/// 落账，然后把同一批按旧帧账的线上形状发给界面。
///
/// 发布形状 = 信封的格子（sessionId/seq/at）并回载荷顶层：实时与重放因此是
/// 同一串字节，界面那一侧不需要知道账本换了表。
fn persist_then_emit<R: Runtime>(app: &AppHandle<R>, batch: FrameBatch) -> bool {
    let logged = Arc::new(batch);
    let mut delay = Duration::from_millis(50);

    let envelopes = loop {
        let stored = Arc::clone(&logged);
        let result = async_runtime::block_on(async {
            let index = app.state::<LocalIndex>();
            on_index(&index, move |store| {
                store
                    .append(
                        &poietica_conversation::identity::ThreadId::new(stored.thread.to_string()),
                        &stored.session,
                        &stored.events,
                    )
                    .map_err(|failure| Error::Internal(failure.to_string()))
            })
            .await
        });

        match result {
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

    let shown = envelopes
        .iter()
        .map(|envelope| {
            poietica_ledger::conversation::screen::screen_frame(
                &envelope.session_id,
                i64::try_from(envelope.seq.value()).unwrap_or(i64::MAX),
                envelope.at,
                &serde_json::to_string(&envelope.event)
                    .unwrap_or_else(|_error| String::from("null")),
            )
        })
        .collect::<serde_json::Result<Vec<_>>>()
        .unwrap_or_default();

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
