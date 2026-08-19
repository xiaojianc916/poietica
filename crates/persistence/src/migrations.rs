use std::collections::HashSet;

use rusqlite::Connection;

use crate::error::Result;
use crate::store::now;

/// Ordered migrations. Never edit one that has shipped; add the next.
///
/// 「没发布过」不等于没有库在跑：开发机上的库早已按 0001 落盘，原地改它
/// 它们永远追不上 —— 新形状从 0002 起一律追加。
const MIGRATIONS: &[(i64, &str, &str)] = &[
    (1, "initial", include_str!("schema/0001_initial.sql")),
    (
        2,
        "session_usage_inputs",
        include_str!("schema/0002_session_usage_inputs.sql"),
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

    /* 记账是一个集合，不是一个最大值：跳过哪一条由「它跑过没有」回答，
    与它的号排在谁前面无关。 */
    let applied: HashSet<i64> = {
        let mut statement = connection.prepare("SELECT version FROM schema_migrations")?;

        statement
            .query_map([], |row| row.get(0))?
            .collect::<std::result::Result<HashSet<i64>, _>>()?
    };

    for (version, name, sql) in MIGRATIONS {
        if applied.contains(version) {
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
