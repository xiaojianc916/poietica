use super::{AppendBatch, events};
use crate::error::{LedgerError, Result};
use poietica_conversation::event::ConversationEvent;
use poietica_conversation::ports::PromptDelivery;
use poietica_conversation::turn::AdmissionDecision;
use poietica_time::WallClock;
use rusqlite::{Transaction, params};

pub(super) fn admit(
    transaction: &Transaction<'_>,
    clock: &dyn WallClock,
    delivery: &PromptDelivery,
) -> Result<AdmissionDecision> {
    let admission = &delivery.admission;
    let attachments = serde_json::to_string(&admission.attachments)?;
    let skills = serde_json::to_string(&admission.skills)?;
    let now = clock.now_unix_millis();
    let inserted = transaction.execute(
        "INSERT INTO turn_admissions
         (turn_id, thread_id, prompt, model, attachments, skills, submitted_at_unix_ms, admitted_at_unix_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(turn_id) DO NOTHING",
        params![admission.turn.as_str(), admission.thread.as_str(), admission.prompt,
            admission.model, attachments, skills, admission.submitted_at_unix_millis, now],
    )?;
    let decision = if inserted == 0 {
        let identical: bool = transaction.query_row(
            "SELECT thread_id = ?2 AND prompt = ?3 AND model = ?4
                AND attachments = ?5 AND skills = ?6 AND submitted_at_unix_ms = ?7
             FROM turn_admissions WHERE turn_id = ?1",
            params![
                admission.turn.as_str(),
                admission.thread.as_str(),
                admission.prompt,
                admission.model,
                attachments,
                skills,
                admission.submitted_at_unix_millis
            ],
            |row| row.get(0),
        )?;
        if !identical {
            return Err(LedgerError::AdmissionConflict {
                turn_id: admission.turn.as_str().to_owned(),
            });
        }
        AdmissionDecision::AlreadyAdmitted
    } else {
        transaction.execute(
            "INSERT INTO delivery_outbox (turn_id, thread_id, state, attempts, updated_at_unix_ms)
             VALUES (?1, ?2, 'pending', 0, ?3)",
            params![admission.turn.as_str(), admission.thread.as_str(), now],
        )?;
        AdmissionDecision::Admitted
    };
    let event = ConversationEvent::TurnAdmitted {
        turn: admission.turn.clone(),
    };
    let recorded: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM conversation_events
            WHERE thread_id = ?1 AND turn_id = ?2 AND kind = ?3)",
        params![
            admission.thread.as_str(),
            admission.turn.as_str(),
            event.kind()
        ],
        |row| row.get(0),
    )?;
    if !recorded {
        let batches = [AppendBatch {
            thread: admission.thread.clone(),
            session: delivery.session.clone(),
            events: vec![event],
        }];
        let _stamps = events::append(transaction, clock, &batches)?;
    }
    Ok(decision)
}
