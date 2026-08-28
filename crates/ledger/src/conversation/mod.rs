pub mod admissions;
pub mod cursors;
pub mod events;
pub mod outbox;

use std::sync::{Mutex, MutexGuard};

use poietica_conversation::error::LedgerUnavailable;
use poietica_conversation::event::{ConversationEvent, EventEnvelope};
use poietica_conversation::identity::{Seq, ThreadId, TurnId};
use poietica_conversation::ports::ConversationLedger;
use poietica_conversation::turn::{Admission, AdmissionDecision, DeliveryOutcome, DeliveryState};
use poietica_time::WallClock;
use rusqlite::Connection;

use crate::error::LedgerError;

/// 时钟显式注入；连接由账本自己拥有，所以它也负责串行化。
#[derive(Debug)]
pub struct SqliteLedger<C: WallClock> {
    connection: Mutex<Connection>,
    clock: C,
}

impl<C: WallClock> SqliteLedger<C> {
    pub fn new(connection: Connection, clock: C) -> Self {
        Self {
            connection: Mutex::new(connection),
            clock,
        }
    }

    /// 中毒是真故障，不是可忽略的软错：报出去，不 unwrap。
    pub fn guard(&self) -> Result<MutexGuard<'_, Connection>, LedgerError> {
        self.connection.lock().map_err(|_| LedgerError::Poisoned)
    }

    pub fn clock(&self) -> &C {
        &self.clock
    }

    /// 建库与迁移用同一个时钟，重放时时间才能对得上。
    pub fn migrate(&self) -> Result<(), LedgerError> {
        let mut guard = self.guard()?;

        crate::migrations::apply(&mut guard, &self.clock)
    }
}

/// 领域只认 LedgerUnavailable；SQLite 的细节到这一层为止。
fn unavailable(error: LedgerError) -> LedgerUnavailable {
    LedgerUnavailable {
        reason: error.to_string(),
    }
}

impl<C: WallClock> ConversationLedger for SqliteLedger<C> {
    fn admit(&self, admission: &Admission) -> Result<AdmissionDecision, LedgerUnavailable> {
        admissions::admit(self, admission).map_err(unavailable)
    }

    fn append(
        &self,
        thread: &ThreadId,
        event: &ConversationEvent,
    ) -> Result<Seq, LedgerUnavailable> {
        events::append(self, thread, event).map_err(unavailable)
    }

    fn events_after(
        &self,
        thread: &ThreadId,
        after: Seq,
    ) -> Result<Vec<EventEnvelope>, LedgerUnavailable> {
        events::after(self, thread, after).map_err(unavailable)
    }

    fn delivery_state(&self, turn: &TurnId) -> Result<Option<DeliveryState>, LedgerUnavailable> {
        outbox::state(self, turn).map_err(unavailable)
    }

    fn record_delivery(
        &self,
        turn: &TurnId,
        outcome: DeliveryOutcome,
    ) -> Result<DeliveryState, LedgerUnavailable> {
        outbox::record(self, turn, outcome).map_err(unavailable)
    }

    fn unresolved_deliveries(&self) -> Result<Vec<Admission>, LedgerUnavailable> {
        outbox::unresolved(self).map_err(unavailable)
    }
}
