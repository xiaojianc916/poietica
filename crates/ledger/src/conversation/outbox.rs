use poietica_conversation::identity::{ThreadId, TurnId};
use poietica_conversation::turn::{Admission, DeliveryOutcome, DeliveryState};
use poietica_time::WallClock;
use rusqlite::{OptionalExtension, params};

use crate::conversation::SqliteLedger;
use crate::error::LedgerError;

const STATE_COLUMN: &str = "delivery_outbox.state";

pub fn state<C: WallClock>(
    ledger: &SqliteLedger<C>,
    turn: &TurnId,
) -> Result<Option<DeliveryState>, LedgerError> {
    let guard = ledger.guard()?;
    let stored: Option<String> = guard
        .query_row(
            "SELECT state FROM delivery_outbox WHERE turn_id = ?1",
            params![turn.as_str()],
            |row| row.get(0),
        )
        .optional()?;

    match stored {
        None => Ok(None),
        Some(value) => decode(value).map(Some),
    }
}

/// 状态迁移的规则只存在领域里；账本只把裁决结果写下来。
pub fn record<C: WallClock>(
    ledger: &SqliteLedger<C>,
    turn: &TurnId,
    outcome: DeliveryOutcome,
) -> Result<DeliveryState, LedgerError> {
    let mut guard = ledger.guard()?;
    let transaction = guard.transaction()?;

    let stored: String = transaction.query_row(
        "SELECT state FROM delivery_outbox WHERE turn_id = ?1",
        params![turn.as_str()],
        |row| row.get(0),
    )?;

    let current = decode(stored)?;
    let next = match current.apply(outcome) {
        Ok(next) => next,
        // 重复或迟到的结果不回退已落定的状态：账本不改写历史裁决。
        Err(_) => current,
    };
    let attempted = matches!(
        outcome,
        DeliveryOutcome::Sent | DeliveryOutcome::Indeterminate
    );

    transaction.execute(
        "UPDATE delivery_outbox
            SET state = ?2, attempts = attempts + ?3, updated_at_unix_ms = ?4
          WHERE turn_id = ?1",
        params![
            turn.as_str(),
            next.as_stored(),
            i64::from(attempted),
            ledger.clock().now_unix_millis(),
        ],
    )?;
    transaction.commit()?;

    Ok(next)
}

/// 「欠着」的定义只在这一条 SQL 里出现一次。
pub fn unresolved<C: WallClock>(ledger: &SqliteLedger<C>) -> Result<Vec<Admission>, LedgerError> {
    let guard = ledger.guard()?;
    let mut statement = guard.prepare(
        "SELECT a.turn_id, a.thread_id, a.prompt, a.model, a.attachments,
                a.submitted_at_unix_ms
           FROM delivery_outbox AS o
           JOIN turn_admissions AS a ON a.turn_id = o.turn_id
          WHERE o.state IN ('pending', 'sent', 'unknown')
          ORDER BY o.updated_at_unix_ms",
    )?;

    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, i64>(5)?,
        ))
    })?;

    let mut admissions = Vec::new();

    for row in rows {
        let (turn, thread, prompt, model, attachments, submitted) = row?;

        admissions.push(Admission {
            thread: ThreadId::new(thread),
            turn: TurnId::new(turn),
            prompt,
            model,
            attachments: serde_json::from_str(&attachments)?,
            submitted_at_unix_millis: submitted,
        });
    }

    Ok(admissions)
}

fn decode(value: String) -> Result<DeliveryState, LedgerError> {
    match DeliveryState::from_stored(&value) {
        Some(state) => Ok(state),
        None => Err(LedgerError::UnknownStoredValue {
            column: STATE_COLUMN,
            value,
        }),
    }
}
