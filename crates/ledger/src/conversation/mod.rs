pub mod admissions;
pub mod cursors;
pub mod events;
pub mod outbox;
pub mod screen;

use std::sync::{Mutex, MutexGuard};

use poietica_conversation::error::LedgerUnavailable;
use poietica_conversation::event::{ConversationEvent, EventEnvelope};
use poietica_conversation::identity::{Seq, ThreadId, TurnId};
use poietica_conversation::ports::ConversationLedger;
use poietica_conversation::turn::{Admission, AdmissionDecision, DeliveryOutcome, DeliveryState};
use poietica_time::WallClock;
use rusqlite::Connection;

use crate::error::LedgerError;
use crate::index::AgentStore;

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

/// 领域只看得见 LedgerUnavailable；SQLite 的细节到这一层为止。
fn unavailable(error: &LedgerError) -> LedgerUnavailable {
    LedgerUnavailable {
        reason: error.to_string(),
    }
}

impl<C: WallClock> ConversationLedger for SqliteLedger<C> {
    fn admit(&self, admission: &Admission) -> Result<AdmissionDecision, LedgerUnavailable> {
        let mut guard = self.guard().map_err(|error| unavailable(&error))?;
        let transaction = guard
            .transaction()
            .map_err(|error| unavailable(&LedgerError::from(error)))?;
        let decision = admissions::admit(&transaction, self.clock(), admission)
            .map_err(|error| unavailable(&error))?;
        transaction
            .commit()
            .map_err(|error| unavailable(&LedgerError::from(error)))?;
        Ok(decision)
    }

    fn append(
        &self,
        thread: &ThreadId,
        session: &str,
        events: &[ConversationEvent],
    ) -> Result<Vec<EventEnvelope>, LedgerUnavailable> {
        let mut guard = self.guard().map_err(|error| unavailable(&error))?;
        let transaction = guard
            .transaction()
            .map_err(|error| unavailable(&LedgerError::from(error)))?;
        let envelopes = events::append(&transaction, self.clock(), thread, session, events)
            .map_err(|error| unavailable(&error))?;
        transaction
            .commit()
            .map_err(|error| unavailable(&LedgerError::from(error)))?;
        Ok(envelopes)
    }

    fn events_after(
        &self,
        thread: &ThreadId,
        after: Seq,
    ) -> Result<Vec<EventEnvelope>, LedgerUnavailable> {
        let guard = self.guard().map_err(|error| unavailable(&error))?;
        events::after(&guard, thread, after).map_err(|error| unavailable(&error))
    }

    fn delivery_state(&self, turn: &TurnId) -> Result<Option<DeliveryState>, LedgerUnavailable> {
        let guard = self.guard().map_err(|error| unavailable(&error))?;
        outbox::state(&guard, turn).map_err(|error| unavailable(&error))
    }

    fn record_delivery(
        &self,
        turn: &TurnId,
        outcome: DeliveryOutcome,
    ) -> Result<DeliveryState, LedgerUnavailable> {
        let mut guard = self.guard().map_err(|error| unavailable(&error))?;
        let transaction = guard
            .transaction()
            .map_err(|error| unavailable(&LedgerError::from(error)))?;
        let state = outbox::record(&transaction, self.clock(), turn, outcome)
            .map_err(|error| unavailable(&error))?;
        transaction
            .commit()
            .map_err(|error| unavailable(&LedgerError::from(error)))?;
        Ok(state)
    }

    fn unresolved_deliveries(&self) -> Result<Vec<Admission>, LedgerUnavailable> {
        let guard = self.guard().map_err(|error| unavailable(&error))?;
        outbox::unresolved(&guard).map_err(|error| unavailable(&error))
    }
}

/// 同一条库上的另一份端口实现。
///
/// 进程里只有一条连接（local_index 的约定），所以组合根里的账本端口就是它：
/// 领域的准入/发件箱与索引的读写共用一个写者，谁也不会绕过谁的锁。
impl ConversationLedger for AgentStore {
    fn admit(&self, admission: &Admission) -> Result<AdmissionDecision, LedgerUnavailable> {
        let transaction = self
            .unchecked_transaction()
            .map_err(|error| unavailable(&error))?;
        let decision = admissions::admit(&transaction, self.clock(), admission)
            .map_err(|error| unavailable(&error))?;
        transaction
            .commit()
            .map_err(|error| unavailable(&LedgerError::from(error)))?;
        Ok(decision)
    }

    fn append(
        &self,
        thread: &ThreadId,
        session: &str,
        events: &[ConversationEvent],
    ) -> Result<Vec<EventEnvelope>, LedgerUnavailable> {
        let transaction = self
            .unchecked_transaction()
            .map_err(|error| unavailable(&error))?;
        let envelopes = events::append(&transaction, self.clock(), thread, session, events)
            .map_err(|error| unavailable(&error))?;
        transaction
            .commit()
            .map_err(|error| unavailable(&LedgerError::from(error)))?;
        Ok(envelopes)
    }

    fn events_after(
        &self,
        thread: &ThreadId,
        after: Seq,
    ) -> Result<Vec<EventEnvelope>, LedgerUnavailable> {
        events::after(&self.connection, thread, after).map_err(|error| unavailable(&error))
    }

    fn delivery_state(&self, turn: &TurnId) -> Result<Option<DeliveryState>, LedgerUnavailable> {
        outbox::state(&self.connection, turn).map_err(|error| unavailable(&error))
    }

    fn record_delivery(
        &self,
        turn: &TurnId,
        outcome: DeliveryOutcome,
    ) -> Result<DeliveryState, LedgerUnavailable> {
        let transaction = self
            .unchecked_transaction()
            .map_err(|error| unavailable(&error))?;
        let state = outbox::record(&transaction, self.clock(), turn, outcome)
            .map_err(|error| unavailable(&error))?;
        transaction
            .commit()
            .map_err(|error| unavailable(&LedgerError::from(error)))?;
        Ok(state)
    }

    fn unresolved_deliveries(&self) -> Result<Vec<Admission>, LedgerUnavailable> {
        outbox::unresolved(&self.connection).map_err(|error| unavailable(&error))
    }
}
