use poietica_conversation::turn::{Admission, AdmissionDecision};
use poietica_time::WallClock;
use rusqlite::{Transaction, params};

use crate::error::LedgerError;

/// turn_id 是主键，所以 ON CONFLICT DO NOTHING 的影响行数就是幂等判据：
/// 0 表示这一轮早就被冻结过，不能再欠一次投递。
/// 事务由调用方开、由调用方提交：冻结意图与「欠一次投递」是同一件事。
pub fn admit(
    transaction: &Transaction<'_>,
    clock: &dyn WallClock,
    admission: &Admission,
) -> Result<AdmissionDecision, LedgerError> {
    let attachments = serde_json::to_string(&admission.attachments)?;
    let skills = serde_json::to_string(&admission.skills)?;
    let now = clock.now_unix_millis();

    let inserted = transaction.execute(
        "INSERT INTO turn_admissions
             (turn_id, thread_id, prompt, model, attachments, skills,
              submitted_at_unix_ms, admitted_at_unix_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (turn_id) DO NOTHING",
        params![
            admission.turn.as_str(),
            admission.thread.as_str(),
            admission.prompt,
            admission.model,
            attachments,
            skills,
            admission.submitted_at_unix_millis,
            now,
        ],
    )?;

    if inserted == 0 {
        return Ok(AdmissionDecision::AlreadyAdmitted);
    }

    // 冻结意图与「欠一次投递」是同一件事，必须在同一个事务里。
    transaction.execute(
        "INSERT INTO delivery_outbox
             (turn_id, thread_id, state, attempts, updated_at_unix_ms)
         VALUES (?1, ?2, 'pending', 0, ?3)",
        params![admission.turn.as_str(), admission.thread.as_str(), now],
    )?;

    Ok(AdmissionDecision::Admitted)
}
