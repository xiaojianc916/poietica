use poietica_conversation::event::{ConversationEvent, EventEnvelope};
use poietica_conversation::identity::{Seq, ThreadId};
use poietica_time::WallClock;
use rusqlite::{Connection, Transaction, params};

use crate::error::LedgerError;

/// seq 由账本分配：在同一个事务里取 max + 1 顺序编下去，所以它在一条对话内
/// 单调无空洞。事务由调用方开、由调用方提交：一批帧共用一次提交。
/// 信封的 seq/at 由这里发给 —— 写路径不自报时间与位置。
pub fn append(
    transaction: &Transaction<'_>,
    clock: &dyn WallClock,
    thread: &ThreadId,
    session: &str,
    events: &[ConversationEvent],
) -> Result<Vec<EventEnvelope>, LedgerError> {
    let last: Option<i64> = transaction.query_row(
        "SELECT MAX(seq) FROM conversation_events WHERE thread_id = ?1",
        params![thread.as_str()],
        |row| row.get(0),
    )?;

    let mut next = u64::try_from(last.unwrap_or(0)).unwrap_or(0);
    let at = clock.now_unix_millis();
    let mut envelopes = Vec::with_capacity(events.len());

    for event in events {
        next = next.saturating_add(1);
        let seq = Seq::new(next);
        let payload = serde_json::to_string(event)?;
        let turn = event.turn().map(|turn| turn.as_str().to_owned());

        transaction.execute(
            "INSERT INTO conversation_events
                 (thread_id, seq, turn_id, kind, payload, recorded_at_unix_ms, session_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                thread.as_str(),
                i64::try_from(seq.value()).unwrap_or(i64::MAX),
                turn,
                event.kind(),
                payload,
                at,
                session,
            ],
        )?;

        envelopes.push(EventEnvelope {
            thread: thread.clone(),
            seq,
            at,
            session_id: session.to_owned(),
            event: event.clone(),
        });
    }

    Ok(envelopes)
}

pub fn after(
    connection: &Connection,
    thread: &ThreadId,
    after: Seq,
) -> Result<Vec<EventEnvelope>, LedgerError> {
    let mut statement = connection.prepare(
        "SELECT seq, recorded_at_unix_ms, session_id, payload FROM conversation_events
          WHERE thread_id = ?1 AND seq > ?2
          ORDER BY seq",
    )?;

    let rows = statement.query_map(
        params![
            thread.as_str(),
            i64::try_from(after.value()).unwrap_or(i64::MAX)
        ],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
            ))
        },
    )?;

    let mut events = Vec::new();

    for row in rows {
        let (seq, at, session_id, payload) = row?;

        events.push(EventEnvelope {
            thread: thread.clone(),
            seq: Seq::new(u64::try_from(seq).unwrap_or(0)),
            at,
            // 0008 之前的领域事件（TurnAdmitted）没有会话可归属；重放按线程走，
            // 缺席即是「这一格早于会话归属」的诚实说法。
            session_id: session_id.unwrap_or_default(),
            event: serde_json::from_str(&payload)?,
        });
    }

    Ok(events)
}
