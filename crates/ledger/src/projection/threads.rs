use poietica_conversation::identity::{Seq, ThreadId};
use poietica_conversation::projection::ThreadView;
use poietica_time::WallClock;
use rusqlite::{Connection, OptionalExtension, params};

use crate::error::LedgerError;

/// 侧栏要的一行。它是派生数据，删了也能从事件重算。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadRow {
    pub thread: ThreadId,
    pub title: Option<String>,
    pub busy: bool,
    pub last_seq: Seq,
}

/// 标题截断长度，按字符而不是字节，避免把半个码点写进账本。
const MAX_TITLE_CHARS: usize = 80;

/// 忙不忙由投影算：有未终结的轮次就是忙。UI 不自己记一份。
/// 一条 upsert 原子成立，不需要自己的事务。
pub fn upsert(
    connection: &Connection,
    clock: &dyn WallClock,
    view: &ThreadView,
) -> Result<(), LedgerError> {
    let busy = view.turns.values().any(|turn| !turn.state.is_finished());
    let title = derive_title(connection, &view.thread)?;

    connection.execute(
        "INSERT INTO thread_projection
             (thread_id, title, busy, last_seq, updated_at_unix_ms)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (thread_id) DO UPDATE SET
             title = excluded.title,
             busy = excluded.busy,
             last_seq = excluded.last_seq,
             updated_at_unix_ms = excluded.updated_at_unix_ms",
        params![
            view.thread.as_str(),
            title,
            i64::from(busy),
            i64::try_from(view.last_seq.value()).unwrap_or(i64::MAX),
            clock.now_unix_millis(),
        ],
    )?;

    Ok(())
}

pub fn list(connection: &Connection, limit: u32) -> Result<Vec<ThreadRow>, LedgerError> {
    let mut statement = connection.prepare(
        "SELECT thread_id, title, busy, last_seq
           FROM thread_projection
          ORDER BY updated_at_unix_ms DESC
          LIMIT ?1",
    )?;

    let rows = statement.query_map(params![limit], |row| {
        Ok(ThreadRow {
            thread: ThreadId::new(row.get::<_, String>(0)?),
            title: row.get(1)?,
            busy: row.get::<_, i64>(2)? != 0,
            last_seq: Seq::new(u64::try_from(row.get::<_, i64>(3)?).unwrap_or(0)),
        })
    })?;

    let mut threads = Vec::new();

    for row in rows {
        threads.push(row?);
    }

    Ok(threads)
}

/// 标题不是另一份真相：取这条对话第一次准入的提示词。
fn derive_title(connection: &Connection, thread: &ThreadId) -> Result<Option<String>, LedgerError> {
    let prompt: Option<String> = connection
        .query_row(
            "SELECT prompt FROM turn_admissions
              WHERE thread_id = ?1
              ORDER BY admitted_at_unix_ms
              LIMIT 1",
            params![thread.as_str()],
            |row| row.get(0),
        )
        .optional()?;

    Ok(prompt.map(|prompt| prompt.chars().take(MAX_TITLE_CHARS).collect()))
}
