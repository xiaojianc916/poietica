mod admissions;
pub mod cursors;
pub mod events;
pub mod outbox;
pub mod screen;

use std::sync::{Mutex, MutexGuard};

use poietica_conversation::error::LedgerUnavailable;
use poietica_conversation::event::{ConversationEvent, EventEnvelope};
use poietica_conversation::identity::{Seq, ThreadId, TurnId};
use poietica_conversation::ports::{ConversationLedger, PromptDelivery};
use poietica_conversation::turn::{Admission, AdmissionDecision, DeliveryOutcome, DeliveryState};
use poietica_time::WallClock;
use rusqlite::Connection;

use crate::error::LedgerError;
use crate::index::AgentStore;

/// 同一次 journal flush 中一个会话的连续事件。
#[derive(Debug)]
pub struct AppendBatch {
    pub thread: ThreadId,
    pub session: String,
    pub events: Vec<ConversationEvent>,
}

fn finish_batches(
    batches: &mut [AppendBatch],
    stamps: Vec<Vec<events::Stamp>>,
) -> Vec<Vec<EventEnvelope>> {
    batches
        .iter_mut()
        .zip(stamps)
        .map(|(batch, stamps)| {
            let thread = batch.thread.clone();
            let session_id = batch.session.clone();
            std::mem::take(&mut batch.events)
                .into_iter()
                .zip(stamps)
                .map(|(event, (seq, at))| EventEnvelope {
                    thread: thread.clone(),
                    seq,
                    at,
                    session_id: session_id.clone(),
                    event,
                })
                .collect()
        })
        .collect()
}

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
    fn admit(&self, admission: &PromptDelivery) -> Result<AdmissionDecision, LedgerUnavailable> {
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
        let mut batches = [AppendBatch {
            thread: thread.clone(),
            session: session.to_owned(),
            events: events.to_vec(),
        }];
        let stamps = events::append(&transaction, self.clock(), &batches)
            .map_err(|error| unavailable(&error))?;
        transaction
            .commit()
            .map_err(|error| unavailable(&LedgerError::from(error)))?;
        Ok(finish_batches(&mut batches, stamps)
            .pop()
            .unwrap_or_default())
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

impl AgentStore {
    /// 同一拍接受的所有会话批次共用一次提交；结果与输入批次一一对应。
    pub fn append_batches(
        &self,
        batches: &mut [AppendBatch],
    ) -> Result<Vec<Vec<EventEnvelope>>, LedgerUnavailable> {
        let transaction = self
            .unchecked_transaction()
            .map_err(|error| unavailable(&error))?;
        let stamps = events::append(&transaction, self.clock(), batches)
            .map_err(|error| unavailable(&error))?;
        transaction
            .commit()
            .map_err(|error| unavailable(&LedgerError::from(error)))?;
        Ok(finish_batches(batches, stamps))
    }
}

/// 应用 writer actor 使用的领域端口实现。准入、发件箱、索引与帧追加
/// 都在同一条写队列上取得总序。
impl ConversationLedger for AgentStore {
    fn admit(&self, admission: &PromptDelivery) -> Result<AdmissionDecision, LedgerUnavailable> {
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
        let mut batches = [AppendBatch {
            thread: thread.clone(),
            session: session.to_owned(),
            events: events.to_vec(),
        }];
        let mut appended = self.append_batches(&mut batches)?;
        Ok(appended.pop().unwrap_or_default())
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

impl AgentStore {
    pub fn admit_submission<F>(
        &self,
        delivery: &PromptDelivery,
        opener: &str,
        attached: &[crate::index::ThreadAttachment],
        validate: F,
    ) -> Result<(AdmissionDecision, DeliveryState), LedgerError>
    where
        F: FnOnce(&Self) -> Result<(), LedgerError>,
    {
        let thread = uuid::Uuid::parse_str(delivery.admission.thread.as_str())
            .map_err(|error| LedgerError::InvalidSubmission(error.to_string()))?;
        let references = &delivery.admission.attachments;
        if references.len() != attached.len()
            || !references
                .iter()
                .zip(attached)
                .all(|(reference, metadata)| {
                    reference.hash == metadata.hash && reference.mime == metadata.mime
                })
        {
            return Err(LedgerError::InvalidSubmission(
                "attachment metadata does not match the frozen references".to_owned(),
            ));
        }
        let timestamp = self.now()?;
        let transaction = self.unchecked_transaction()?;
        validate(self)?;
        let decision = admissions::admit(&transaction, self.clock(), delivery)?;
        if decision == AdmissionDecision::Admitted {
            self.record_prompt(thread, opener)?;
            for attachment in attached {
                crate::index::attachments::remember_in(
                    &transaction,
                    &timestamp,
                    thread,
                    attachment,
                )?;
            }
        }
        let state = outbox::state(&transaction, &delivery.admission.turn)?.ok_or_else(|| {
            LedgerError::InvalidSubmission("admission has no outbox row".to_owned())
        })?;
        transaction.commit()?;
        Ok((decision, state))
    }
}

#[cfg(test)]
mod submission_tests {
    #![allow(
        clippy::expect_used,
        reason = "transaction failures must fail their fixtures"
    )]
    use super::*;
    use crate::index::ThreadAttachment;
    use poietica_time::wall_clock::SystemWallClock;

    #[test]
    fn attachment_failure_rolls_back_the_entire_submission() {
        let directory = tempfile::tempdir().expect("directory");
        let store = AgentStore::open(&directory.path().join("index.sqlite3"), SystemWallClock)
            .expect("store");
        let thread = uuid::Uuid::new_v4();
        store
            .create_thread(thread, "新建对话", Some("/workspace"))
            .expect("thread");
        let before = store.thread(thread).expect("read").expect("exists");
        store
            .connection
            .execute_batch(
                "CREATE TRIGGER reject_link BEFORE INSERT ON thread_attachments
             BEGIN SELECT RAISE(ABORT, 'reference unavailable'); END;",
            )
            .expect("trigger");
        let attachment = ThreadAttachment {
            hash: "a".repeat(64),
            mime: "image/png".to_owned(),
            name: "image.png".to_owned(),
            byte_size: 4,
        };
        let mut admission = Admission {
            thread: ThreadId::new(thread.to_string()),
            turn: TurnId::new("rollback".to_owned()),
            prompt: "hello".to_owned(),
            model: String::new(),
            attachments: Vec::new(),
            skills: Vec::new(),
            submitted_at_unix_millis: 1,
        };
        admission.attachments = serde_json::from_value(serde_json::json!([
            {"hash": attachment.hash, "mime": attachment.mime}
        ]))
        .expect("attachment reference");
        let request = PromptDelivery {
            admission,
            session: "session".to_owned(),
        };
        assert!(
            store
                .admit_submission(&request, "hello", &[attachment], |_| Ok(()))
                .is_err()
        );
        let after = store.thread(thread).expect("read").expect("exists");
        assert_eq!(after.title, before.title);
        assert_eq!(
            std::mem::discriminant(&after.title_source),
            std::mem::discriminant(&before.title_source)
        );
        assert_eq!(after.updated_at, before.updated_at);
        assert!(store.attachments_of(thread).expect("references").is_empty());
        assert!(store.unresolved_deliveries().expect("outbox").is_empty());
        assert!(
            store
                .events_after(&request.admission.thread, Seq::NONE)
                .expect("events")
                .is_empty()
        );
        let blobs: i64 = store
            .connection
            .query_row("SELECT COUNT(*) FROM attachments", [], |row| row.get(0))
            .expect("blobs");
        assert_eq!(blobs, 0);
    }
}
