//! Which session an update belongs to.
//!
//! One agent process can hold several sessions at once, and every frame the
//! agent sends names the session it belongs to. This book is that name
//! resolved: one slot per session, so a frame is recorded against the run
//! that asked for it rather than against whichever run started last.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard};

use crate::error::{KapError, Result};
use crate::run_slot::RunSlot;
use poietica_conversation::link::LinkState;

/// The open sessions of one agent process, keyed by protocol session id.
///
/// Cheap to clone: every clone reads and writes the same book.
#[derive(Clone, Default)]
pub struct SessionBook {
    slots: Arc<Mutex<HashMap<String, RunSlot>>>,
}

/// The contents are recorders, which are not printable, so the count is.
impl fmt::Debug for SessionBook {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let open = match self.slots.lock() {
            Ok(ledger) => Some(ledger.len()),
            Err(_poisoned) => None,
        };

        formatter
            .debug_struct("SessionBook")
            .field("open", &open)
            .finish()
    }
}

impl SessionBook {
    /// An empty book.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The slot of a session, opened on first mention.
    pub fn open(&self, session_id: &str) -> Result<RunSlot> {
        let mut ledger = self.book()?;
        let opened = ledger
            .entry(session_id.to_owned())
            .or_insert_with(RunSlot::new);

        Ok(opened.clone())
    }

    /// The slot of a session already open, and nothing for any other name.
    ///
    /// A frame naming a session this client never opened is not ours to
    /// record, so the caller is told plainly instead of being handed a slot.
    pub fn slot(&self, session_id: &str) -> Result<Option<RunSlot>> {
        Ok(self.book()?.get(session_id).cloned())
    }

    /// Forgets a session, reporting whether it was open.
    pub fn close(&self, session_id: &str) -> Result<bool> {
        Ok(self.book()?.remove(session_id).is_some())
    }

    /// Ends one turn on the agent's own terms, reporting whether one was open.
    pub fn finish_turn(&self, session_id: &str, stop_reason: &str) -> Result<bool> {
        match self.slot(session_id)? {
            Some(slot) => Ok(close(&slot, Ending::Finished(stop_reason), None)),
            None => Ok(false),
        }
    }

    /// Ends one turn this machine has judged dead, reporting whether one was open.
    pub fn fail_turn(&self, session_id: &str, message: &str) -> Result<bool> {
        match self.slot(session_id)? {
            Some(slot) => Ok(close(&slot, Ending::Failed(message), None)),
            None => Ok(false),
        }
    }

    /// 这条会话已经落过几道终帧；没有槽就没有答案。
    pub fn ended_count(&self, session_id: &str) -> Result<Option<u64>> {
        let Some(slot) = self.slot(session_id)? else {
            return Ok(None);
        };

        let mut ended = None;
        slot.record(|recorder| ended = Some(recorder.ended()));

        Ok(ended)
    }

    /// 收摊，但只收 since 那一刻还在飞的那一轮。
    ///
    /// 取消的宽限期是一个定时器，它到期时在飞的可能已经是下一轮：不认轮就会把人
    /// 刚发出去的那一句判成 cancelled。
    pub fn finish_turn_since(
        &self,
        session_id: &str,
        stop_reason: &str,
        since: u64,
    ) -> Result<bool> {
        match self.slot(session_id)? {
            Some(slot) => Ok(close(&slot, Ending::Finished(stop_reason), Some(since))),
            None => Ok(false),
        }
    }

    /// Ends every turn still owned by this connection.
    pub fn fail_active(&self, message: &str) -> Result<usize> {
        let slots = self.book()?.values().cloned().collect::<Vec<RunSlot>>();
        let mut failed = 0;

        for slot in slots {
            if close(&slot, Ending::Failed(message), None) {
                failed += 1;
            }
        }

        Ok(failed)
    }

    /// 把链路态记进每一轮在飞的账，交代记了几笔。
    ///
    /// 没有一轮在飞就一笔不记：链路的事只在它耽误了某一轮的时候才是那一轮的事。
    pub fn note_link(&self, link: &LinkState) -> Result<usize> {
        let slots = self.book()?.values().cloned().collect::<Vec<RunSlot>>();
        let mut noted = 0;

        for slot in slots {
            if slot.record(|recorder| recorder.record_link(link)) {
                noted += 1;
            }
        }

        Ok(noted)
    }

    /// How many sessions are open.
    pub fn open_count(&self) -> Result<usize> {
        Ok(self.book()?.len())
    }

    /// The identifiers of the open sessions, in no order worth relying on.
    pub fn ids(&self) -> Result<Vec<String>> {
        Ok(self.book()?.keys().cloned().collect())
    }

    /// Files a slot that already exists under a session name.
    ///
    /// The first session of a connection is created by the driver, which
    /// was handed its slot before any name existed to file it under. The
    /// book adopts that slot instead of making a second one, so there is
    /// still exactly one place a frame can be recorded.
    pub fn adopt(&self, session_id: &str, slot: RunSlot) -> Result<()> {
        let mut ledger = self.book()?;
        let _replaced = ledger.insert(session_id.to_owned(), slot);

        Ok(())
    }

    fn book(&self) -> Result<MutexGuard<'_, HashMap<String, RunSlot>>> {
        self.slots.lock().map_err(|_poisoned| KapError::Poisoned)
    }
}

/// 一轮为什么结束。帧契约只有两种终帧，所以收场也只有两种。
#[derive(Clone, Copy, Debug)]
enum Ending<'a> {
    /// agent 自己报的停止原因。
    Finished(&'a str),
    /// 本机判定的失败，带一句给人看的话。
    Failed(&'a str),
}

/// 收摊：没答的作废，终帧殿后。不在飞的那一轮不收第二次；since 给出时，只收那
/// 一刻还在飞的那一轮。
fn close(slot: &RunSlot, ending: Ending<'_>, since: Option<u64>) -> bool {
    let mut ended = false;

    slot.record(|recorder| {
        if !recorder.is_running() || since.is_some_and(|mark| recorder.ended() != mark) {
            return;
        }

        recorder.record_pending_cancelled();

        match ending {
            Ending::Finished(stop_reason) => recorder.record_run_finished(stop_reason),
            Ending::Failed(message) => recorder.record_run_failed(message),
        }

        ended = true;
    });

    ended
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::SessionBook;
    use crate::frame::RunFrame;
    use crate::recorder::{RecordedEvent, Recorder};
    use crate::run_slot::RunSlot;

    const NAME: &str = "session_33333333-3333-4333-8333-333333333333";

    #[test]
    fn an_adopted_slot_answers_under_its_session_name() {
        let book = SessionBook::new();

        assert!(book.adopt(NAME, RunSlot::new()).is_ok());
        assert!(matches!(book.slot(NAME), Ok(Some(_))));
    }

    #[test]
    fn adopting_a_known_name_does_not_open_a_second_session() {
        let book = SessionBook::new();

        assert!(book.open(NAME).is_ok());
        assert!(book.adopt(NAME, RunSlot::new()).is_ok());
        assert!(matches!(book.open_count(), Ok(1)));
    }

    #[test]
    fn connection_loss_ends_the_turn_it_owned() {
        let book = SessionBook::new();
        let opened = book.open(NAME);
        assert!(opened.is_ok());
        let Some(slot) = opened.ok() else {
            return;
        };
        let seen = Arc::new(Mutex::new(Vec::<RecordedEvent>::new()));
        let delivered = Arc::clone(&seen);
        let recorder = Recorder::new(
            NAME.to_owned(),
            slot.seq(),
            Box::new(move |event| {
                if let Ok(mut events) = delivered.lock() {
                    events.push(event);
                }
                true
            }),
        );

        assert!(slot.attach(|| recorder).is_ok());
        slot.record(|frames| {
            frames.record_prompt_admitted("adm", "hi", Vec::new(), Vec::new());
        });
        assert!(matches!(book.fail_active("agent connection lost"), Ok(1)));
        assert!(seen.lock().is_ok_and(|events| {
            events
                .last()
                .is_some_and(|event| matches!(&event.frame, RunFrame::RunFailed { .. }))
        }));
        assert!(!slot.is_listening());
    }

    /// 取消的截止期与 agent 自己的终帧会同时到，两者都走 close：先到的那一个
    /// 收摊，后到的必须是空操作，否则一轮会记下两道终帧。
    #[test]
    fn a_turn_is_only_ended_once() {
        let book = SessionBook::new();
        let opened = book.open(NAME);
        assert!(opened.is_ok());
        let Some(slot) = opened.ok() else {
            return;
        };
        let recorder = Recorder::new(NAME.to_owned(), slot.seq(), Box::new(|_event| true));

        assert!(slot.attach(|| recorder).is_ok());
        slot.record(|frames| {
            frames.record_prompt_admitted("adm", "hi", Vec::new(), Vec::new());
        });
        assert!(matches!(book.finish_turn(NAME, "cancelled"), Ok(true)));
        assert!(matches!(book.finish_turn(NAME, "cancelled"), Ok(false)));
        assert!(matches!(book.fail_turn(NAME, "too late"), Ok(false)));
    }
}
