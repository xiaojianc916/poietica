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

    /// Ends every turn still owned by this connection.
    pub fn fail_active(&self, message: &str) -> Result<usize> {
        let slots = self.book()?.values().cloned().collect::<Vec<RunSlot>>();
        let mut failed = 0;

        for slot in slots {
            if let Some(mut recorder) = slot.take()? {
                recorder.record_pending_cancelled();
                recorder.record_run_failed(message);
                failed += 1;
            }
        }

        Ok(failed)
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
            }),
        );

        assert!(slot.install(recorder).is_ok());
        assert!(matches!(book.fail_active("agent connection lost"), Ok(1)));
        assert!(seen.lock().is_ok_and(|events| {
            events
                .last()
                .is_some_and(|event| matches!(&event.frame, RunFrame::RunFailed { .. }))
        }));
        assert!(!slot.is_listening());
    }
}
