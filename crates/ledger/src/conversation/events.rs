use std::collections::HashMap;
use std::collections::hash_map::Entry;

use poietica_conversation::event::EventEnvelope;
use poietica_conversation::identity::{Seq, ThreadId};
use poietica_time::WallClock;
use rusqlite::{Connection, Transaction, params};

use super::AppendBatch;
use crate::error::LedgerError;

pub(super) type Stamp = (Seq, i64);

pub(super) fn append(
    transaction: &Transaction<'_>,
    clock: &dyn WallClock,
    batches: &[AppendBatch],
) -> Result<Vec<Vec<Stamp>>, LedgerError> {
    let mut next_by_thread = HashMap::<&str, u64>::new();
    let mut insert = transaction.prepare(
        "INSERT INTO conversation_events
             (thread_id, seq, turn_id, kind, payload, recorded_at_unix_ms, session_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )?;
    let mut stamped = Vec::with_capacity(batches.len());

    for batch in batches {
        let next = match next_by_thread.entry(batch.thread.as_str()) {
            Entry::Occupied(entry) => entry.into_mut(),
            Entry::Vacant(entry) => {
                let last: Option<i64> = transaction.query_row(
                    "SELECT MAX(seq) FROM conversation_events WHERE thread_id = ?1",
                    params![batch.thread.as_str()],
                    |row| row.get(0),
                )?;
                entry.insert(u64::try_from(last.unwrap_or(0)).unwrap_or(0))
            }
        };
        let at = clock.now_unix_millis();
        let mut batch_stamps = Vec::with_capacity(batch.events.len());

        for event in &batch.events {
            *next = next.saturating_add(1);
            let seq = Seq::new(*next);
            let payload = serde_json::to_string(event)?;
            let turn = event.turn().map(|turn| turn.as_str().to_owned());

            insert.execute(params![
                batch.thread.as_str(),
                i64::try_from(seq.value()).unwrap_or(i64::MAX),
                turn,
                event.kind(),
                payload,
                at,
                batch.session,
            ])?;
            batch_stamps.push((seq, at));
        }
        stamped.push(batch_stamps);
    }

    Ok(stamped)
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
    let mut found = Vec::new();

    for row in rows {
        let (seq, at, session_id, payload) = row?;
        found.push(EventEnvelope {
            thread: thread.clone(),
            seq: Seq::new(u64::try_from(seq).unwrap_or(0)),
            at,
            session_id: session_id.unwrap_or_default(),
            event: serde_json::from_str(&payload)?,
        });
    }
    Ok(found)
}
