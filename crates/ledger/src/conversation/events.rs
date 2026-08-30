use poietica_conversation::event::{ConversationEvent, EventEnvelope};
use poietica_conversation::identity::{Seq, ThreadId};
use poietica_time::WallClock;
use rusqlite::{Connection, Transaction, params};

use crate::error::LedgerError;

/// seq 由账本分配：在同一个事务里取 max + 1，所以它在一条对话内单调无空洞。
/// 事务由调用方开、由调用方提交：这里的写与发件箱的状态迁移共享同一次提交。
pub fn append(
    transaction: &Transaction<'_>,
    clock: &dyn WallClock,
    thread: &ThreadId,
    event: &ConversationEvent,
) -> Result<Seq, LedgerError> {
    let last: Option<i64> = transaction.query_row(
        "SELECT MAX(seq) FROM conversation_events WHERE thread_id = ?1",
        params![thread.as_str()],
        |row| row.get(0),
    )?;

    let seq = Seq::new(u64::try_from(last.unwrap_or(0)).unwrap_or(0)).successor();
    let payload = serde_json::to_string(event)?;
    let turn = event.turn().map(|turn| turn.as_str().to_owned());

    transaction.execute(
        "INSERT INTO conversation_events
             (thread_id, seq, turn_id, kind, payload, recorded_at_unix_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            thread.as_str(),
            i64::try_from(seq.value()).unwrap_or(i64::MAX),
            turn,
            event.kind(),
            payload,
            clock.now_unix_millis(),
        ],
    )?;

    Ok(seq)
}

pub fn after(
    connection: &Connection,
    thread: &ThreadId,
    after: Seq,
) -> Result<Vec<EventEnvelope>, LedgerError> {
    let mut statement = connection.prepare(
        "SELECT seq, payload FROM conversation_events
          WHERE thread_id = ?1 AND seq > ?2
          ORDER BY seq",
    )?;

    let rows = statement.query_map(
        params![
            thread.as_str(),
            i64::try_from(after.value()).unwrap_or(i64::MAX)
        ],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
    )?;

    let mut events = Vec::new();

    for row in rows {
        let (seq, payload) = row?;

        events.push(EventEnvelope {
            thread: thread.clone(),
            seq: Seq::new(u64::try_from(seq).unwrap_or(0)),
            event: serde_json::from_str(&payload)?,
        });
    }

    Ok(events)
}
