use poietica_conversation::turn::{Admission, AdmissionDecision};
use poietica_time::WallClock;
use rusqlite::params;

use crate::conversation::SqliteLedger;
use crate::error::LedgerError;

/// turn_id 是主键，所以 ON CONFLICT DO NOTHING 的影响行数就是幂等判据：
/// 0 表示这一轮早就被冻结过，不能再欠一次投递。
pub fn admit<C: WallClock>(
    ledger: &SqliteLedger<C>,
    admission: &Admission,
) -> Result<AdmissionDecision, LedgerError> {
    let mut guard = ledger.guard()?;
    let transaction = guard.transaction()?;
    let attachments = serde_json::to_string(&admission.attachments)?;
    let now = ledger.clock().now_unix_millis();

    let inserted = transaction.execute(
        "INSERT INTO turn_admissions
             (turn_id, thread_id, prompt, model, attachments,
              submitted_at_unix_ms, admitted_at_unix_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (turn_id) DO NOTHING",
        params![
            admission.turn.as_str(),
            admission.thread.as_str(),
            admission.prompt,
            admission.model,
            attachments,
            admission.submitted_at_unix_millis,
            now,
        ],
    )?;

    if inserted == 0 {
        transaction.commit()?;

        return Ok(AdmissionDecision::AlreadyAdmitted);
    }

    // 冻结意图与「欠一次投递」是同一件事，必须在同一个事务里。
    transaction.execute(
        "INSERT INTO delivery_outbox
             (turn_id, thread_id, state, attempts, updated_at_unix_ms)
         VALUES (?1, ?2, 'pending', 0, ?3)",
        params![admission.turn.as_str(), admission.thread.as_str(), now],
    )?;
    transaction.commit()?;

    Ok(AdmissionDecision::Admitted)
}
