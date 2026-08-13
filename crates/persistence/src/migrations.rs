use rusqlite::Connection;

use crate::error::Result;
use crate::store::now;

/// Ordered migrations. Never edit one that has shipped; add the next.
const MIGRATIONS: &[(i64, &str, &str)] = &[
    (1, "initial", include_str!("schema/0001_initial.sql")),
    (
        2,
        "thread_sessions",
        include_str!("schema/0002_thread_sessions.sql"),
    ),
    (
        3,
        "thread_pinning",
        include_str!("schema/0003_thread_pinning.sql"),
    ),
    (
        4,
        "thread_shelf",
        include_str!("schema/0004_thread_shelf.sql"),
    ),
    (
        5,
        "thread_indexes",
        include_str!("schema/0005_thread_indexes.sql"),
    ),
    (
        6,
        "run_snapshots",
        include_str!("schema/0006_run_snapshots.sql"),
    ),
    (
        7,
        "thread_titles",
        include_str!("schema/0007_thread_titles.sql"),
    ),
    (
        8,
        "thread_agents",
        include_str!("schema/0008_thread_agents.sql"),
    ),
    (
        9,
        "drop_run_log",
        include_str!("schema/0009_drop_run_log.sql"),
    ),
    (
        10,
        "attachments",
        include_str!("schema/0010_attachments.sql"),
    ),
    (
        11,
        "thread_prompts",
        include_str!("schema/0011_thread_prompts.sql"),
    ),
    (
        12,
        "thread_owners",
        include_str!("schema/0012_thread_owners.sql"),
    ),
    (
        13,
        "thread_workspaces",
        include_str!("schema/0013_thread_workspaces.sql"),
    ),
    (14, "turn_spans", include_str!("schema/0014_turn_spans.sql")),
    (
        15,
        "thread_archiving",
        include_str!("schema/0015_thread_archiving.sql"),
    ),
    (
        16,
        "workbench_session",
        include_str!("schema/0016_workbench_session.sql"),
    ),
    (
        17,
        "session_disposals",
        include_str!("schema/0017_session_disposals.sql"),
    ),
    (
        18,
        "thread_usage",
        include_str!("schema/0018_thread_usage.sql"),
    ),
    (
        19,
        "token_usage",
        include_str!("schema/0019_token_usage.sql"),
    ),
];

/// Brings the database up to the current schema version.
///
/// Each migration runs inside a transaction together with the row that records
/// it, so a failure leaves no half applied schema behind.
///
/// # Errors
///
/// Fails when a migration statement is rejected.
pub(crate) fn migrate(connection: &mut Connection) -> Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version    INTEGER PRIMARY KEY,
            name       TEXT    NOT NULL,
            applied_at TEXT    NOT NULL
         ) STRICT;",
    )?;

    let applied: i64 = connection.query_row(
        "SELECT coalesce(max(version), 0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )?;

    for (version, name, sql) in MIGRATIONS {
        if *version <= applied {
            continue;
        }

        let transaction = connection.transaction()?;
        transaction.execute_batch(sql)?;
        // 全库其余每一处时间戳都是 RFC 3339。datetime('now') 产出的是
        // 空格分隔的另一种写法，两种格式放在同一个库里，字符串比较和
        // 排序的语义就不一致了。
        transaction.execute(
            "INSERT INTO schema_migrations (version, name, applied_at)
             VALUES (?1, ?2, ?3)",
            rusqlite::params![version, name, now()?],
        )?;
        transaction.commit()?;
    }

    Ok(())
}
