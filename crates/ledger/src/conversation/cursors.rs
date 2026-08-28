use poietica_conversation::identity::{Seq, ThreadId};
use poietica_time::WallClock;
use rusqlite::{OptionalExtension, params};

use crate::conversation::SqliteLedger;
use crate::error::LedgerError;

/// KAP 续播位置：token 由网关给出，committed_seq 是本地已确认落盘的位置。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cursor {
    pub token: Option<String>,
    pub committed_seq: Seq,
}

pub fn load<C: WallClock>(
    ledger: &SqliteLedger<C>,
    thread: &ThreadId,
) -> Result<Option<Cursor>, LedgerError> {
    let guard = ledger.guard()?;
    let row: Option<(Option<String>, i64)> = guard
        .query_row(
            "SELECT token, committed_seq FROM kap_cursors WHERE thread_id = ?1",
            params![thread.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;

    Ok(row.map(|(token, committed)| Cursor {
        token,
        committed_seq: Seq::new(u64::try_from(committed).unwrap_or(0)),
    }))
}

pub fn save<C: WallClock>(
    ledger: &SqliteLedger<C>,
    thread: &ThreadId,
    cursor: &Cursor,
) -> Result<(), LedgerError> {
    let guard = ledger.guard()?;

    guard.execute(
        "INSERT INTO kap_cursors (thread_id, token, committed_seq, updated_at_unix_ms)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (thread_id) DO UPDATE SET
             token = excluded.token,
             committed_seq = excluded.committed_seq,
             updated_at_unix_ms = excluded.updated_at_unix_ms",
        params![
            thread.as_str(),
            cursor.token,
            i64::try_from(cursor.committed_seq.value()).unwrap_or(i64::MAX),
            ledger.clock().now_unix_millis(),
        ],
    )?;

    Ok(())
}
