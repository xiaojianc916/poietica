use poietica_time::WallClock;
use rusqlite::{Connection, OptionalExtension, params};

use crate::error::LedgerError;

/// 版本号、名字、SQL 一一对应。名字也校验：改名等于改已落盘数据的读法。
const MIGRATIONS: &[(i64, &str, &str)] = &[
    (
        1,
        "conversation_events",
        include_str!("sql/0001_conversation_events.sql"),
    ),
    (
        2,
        "turn_admissions",
        include_str!("sql/0002_turn_admissions.sql"),
    ),
    (
        3,
        "delivery_outbox",
        include_str!("sql/0003_delivery_outbox.sql"),
    ),
    (4, "kap_cursors", include_str!("sql/0004_kap_cursors.sql")),
    (
        5,
        "thread_projection",
        include_str!("sql/0005_thread_projection.sql"),
    ),
    (6, "local_index", include_str!("sql/0006_local_index.sql")),
    (
        7,
        "admission_skills",
        include_str!("sql/0007_admission_skills.sql"),
    ),
    (
        8,
        "screen_journal_merge",
        include_str!("sql/0008_screen_journal_merge.sql"),
    ),
    (
        9,
        "run_events_retirement",
        include_str!("sql/0009_run_events_retirement.sql"),
    ),
    (
        10,
        "attachment_names",
        include_str!("sql/0010_attachment_names.sql"),
    ),
];

pub fn apply(connection: &mut Connection, clock: &dyn WallClock) -> Result<(), LedgerError> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version            INTEGER NOT NULL PRIMARY KEY,
            name               TEXT    NOT NULL,
            applied_at_unix_ms INTEGER NOT NULL
        ) STRICT;",
    )?;

    for (version, name, sql) in MIGRATIONS {
        let recorded: Option<String> = connection
            .query_row(
                "SELECT name FROM schema_migrations WHERE version = ?1",
                params![version],
                |row| row.get(0),
            )
            .optional()?;

        match recorded {
            Some(recorded) if recorded == *name => continue,
            Some(recorded) => {
                return Err(LedgerError::MigrationDrift {
                    version: *version,
                    recorded,
                    expected: (*name).to_owned(),
                });
            }
            None => {}
        }

        let transaction = connection.transaction()?;

        transaction.execute_batch(sql)?;
        transaction.execute(
            "INSERT INTO schema_migrations (version, name, applied_at_unix_ms)
             VALUES (?1, ?2, ?3)",
            params![version, name, clock.now_unix_millis()],
        )?;
        transaction.commit()?;
    }

    Ok(())
}
