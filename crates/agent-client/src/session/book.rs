//! Which session an update belongs to: one slot per protocol session id.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard};

use crate::error::{AgentError, Result};
use crate::run_slot::RunSlot;
use poietica_conversation::link::LinkState;

#[derive(Clone, Default)]
pub struct SessionBook {
    slots: Arc<Mutex<HashMap<String, RunSlot>>>,
}

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
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn open(&self, session_id: &str) -> Result<RunSlot> {
        let mut ledger = self.book()?;
        let opened = ledger
            .entry(session_id.to_owned())
            .or_insert_with(RunSlot::new);

        Ok(opened.clone())
    }

    pub fn slot(&self, session_id: &str) -> Result<Option<RunSlot>> {
        Ok(self.book()?.get(session_id).cloned())
    }

    pub fn close(&self, session_id: &str) -> Result<bool> {
        Ok(self.book()?.remove(session_id).is_some())
    }

    pub fn finish_turn(&self, session_id: &str, stop_reason: &str) -> Result<bool> {
        match self.slot(session_id)? {
            Some(slot) => Ok(close(&slot, Ending::Finished(stop_reason), None)),
            None => Ok(false),
        }
    }

    pub fn fail_turn(&self, session_id: &str, message: &str) -> Result<bool> {
        match self.slot(session_id)? {
            Some(slot) => Ok(close(&slot, Ending::Failed(message), None)),
            None => Ok(false),
        }
    }

    pub fn ended_count(&self, session_id: &str) -> Result<Option<u64>> {
        let Some(slot) = self.slot(session_id)? else {
            return Ok(None);
        };

        let mut ended = None;
        slot.record(|recorder| ended = Some(recorder.ended()));

        Ok(ended)
    }

    pub fn current_prompt(&self, session_id: &str) -> Result<Option<String>> {
        let Some(slot) = self.slot(session_id)? else {
            return Ok(None);
        };

        let mut prompt = None;
        slot.record(|recorder| prompt = recorder.current_prompt().map(str::to_owned));

        Ok(prompt)
    }

    /// 那个 prompt 现在是什么状态。
    ///
    /// 在飞队列里就是 Active；不在队列里说明它已经落过终帧，而终帧只有三种：
    /// 撤了、成了、败了。哪一种由这一轮最后落的那条终帧说了算 —— 所以槽里记着
    /// 结局，不在飞时直接读它。
    pub fn prompt_state(
        &self,
        session_id: &str,
        prompt: &str,
    ) -> Result<Option<crate::session::observe::PromptObservation>> {
        use crate::session::observe::PromptObservation;

        let Some(slot) = self.slot(session_id)? else {
            return Ok(None);
        };

        let mut observed = None;
        slot.record(|recorder| {
            observed = Some(if recorder.holds(prompt) {
                PromptObservation::Active
            } else {
                match recorder.last_outcome() {
                    Some("cancelled") => PromptObservation::Cancelled,
                    Some("failed") => PromptObservation::Failed,
                    Some(_) => PromptObservation::Succeeded,
                    None => PromptObservation::Missing,
                }
            });
        });

        Ok(observed)
    }

    /// 只收 since 那一刻还在飞的那一轮：宽限期到期时在飞的可能已是下一轮。
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

    pub fn open_count(&self) -> Result<usize> {
        Ok(self.book()?.len())
    }

    pub fn ids(&self) -> Result<Vec<String>> {
        Ok(self.book()?.keys().cloned().collect())
    }

    /// Files an existing slot under a session name: the driver's first session gets its slot before any id exists.
    pub fn adopt(&self, session_id: &str, slot: RunSlot) -> Result<()> {
        let mut ledger = self.book()?;
        let _replaced = ledger.insert(session_id.to_owned(), slot);

        Ok(())
    }

    fn book(&self) -> Result<MutexGuard<'_, HashMap<String, RunSlot>>> {
        self.slots.lock().map_err(|_poisoned| AgentError::Poisoned)
    }
}

#[derive(Clone, Copy, Debug)]
enum Ending<'a> {
    Finished(&'a str),
    Failed(&'a str),
}

/// 收摊：先作废没答的，终帧殿后；不在飞的那一轮不收第二次。
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
            frames.record_prompt_admitted("adm", "hi", Vec::new());
        });
        assert!(matches!(book.fail_active("agent connection lost"), Ok(1)));
        assert!(seen.lock().is_ok_and(|events| {
            events
                .last()
                .is_some_and(|event| matches!(&event.frame, RunFrame::RunFailed { .. }))
        }));
        assert!(!slot.is_listening());
    }

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
            frames.record_prompt_admitted("adm", "hi", Vec::new());
        });
        assert!(matches!(book.finish_turn(NAME, "cancelled"), Ok(true)));
        assert!(matches!(book.finish_turn(NAME, "cancelled"), Ok(false)));
        assert!(matches!(book.fail_turn(NAME, "too late"), Ok(false)));
    }

    #[test]
    fn cancel_names_the_running_prompt() {
        let book = SessionBook::new();

        assert!(matches!(book.current_prompt("missing"), Ok(None)));
        assert!(book.open(NAME).is_ok());
        assert!(matches!(book.current_prompt(NAME), Ok(None)));

        let Some(slot) = book.slot(NAME).ok().flatten() else {
            return;
        };
        let recorder = Recorder::new(NAME.to_owned(), slot.seq(), Box::new(|_event| true));

        assert!(slot.attach(|| recorder).is_ok());
        slot.record(|frames| {
            frames.record_prompt_admitted("adm", "hi", Vec::new());
        });
        assert!(matches!(book.current_prompt(NAME), Ok(Some(prompt)) if prompt == "adm"));

        assert!(matches!(book.finish_turn(NAME, "cancelled"), Ok(true)));
        assert!(matches!(book.current_prompt(NAME), Ok(None)));
    }
}
