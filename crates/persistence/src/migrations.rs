use std::collections::HashSet;

use rusqlite::{Connection, Transaction};

use crate::error::Result;
use crate::store::now;

/// 一步迁移怎么落地。
///
/// 条件 DDL 只能由宿主语言裁决：SQLite 的 ALTER TABLE … DROP COLUMN 没有
/// IF EXISTS，列在不在要问 pragma_table_info。纯 SQL 的一步做不到「旧库补
/// 票、新库空转」。
enum Step {
    Sql(&'static str),
    Rust(fn(&Transaction<'_>) -> Result<()>),
}

/// Ordered migrations. Never edit one that has shipped; add the next.
const MIGRATIONS: &[(i64, &str, Step)] = &[
    (
        1,
        "initial",
        Step::Sql(include_str!("schema/0001_initial.sql")),
    ),
    (
        2,
        "run_events",
        Step::Sql(include_str!("schema/0002_run_events.sql")),
    ),
    (
        3,
        "run_events_thread_key",
        Step::Sql(include_str!("schema/0003_run_events_thread_key.sql")),
    ),
    (
        4,
        "attachment_links",
        Step::Sql(include_str!("schema/0004_attachment_links.sql")),
    ),
    (
        5,
        "drop_turn_spans",
        Step::Sql(include_str!("schema/0005_drop_turn_spans.sql")),
    ),
    (7, "reconcile_schema", Step::Rust(reconcile)),
];

/// 把库对到当前形状，判据取自 schema 自身。
///
/// squash 把迁移 1–20 压成一条 0001，版本号从 1 重数。装过旧版的机器上
/// schema_migrations 记着 20，于是新编号的每一条都被判成跑过：run_events 不
/// 会被建。屏幕上的样子是在旧对话里说一句话就得到「本地索引库写入失败」——
/// last_seq 查的正是那张不存在的表。号补不回来，所以这里不问号，问东西在不在。
fn reconcile(transaction: &Transaction<'_>) -> Result<()> {
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS run_events (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            thread_id  TEXT    NOT NULL REFERENCES threads (id),
            session_id TEXT    NOT NULL,
            seq        INTEGER NOT NULL,
            at         INTEGER NOT NULL,
            frame      TEXT    NOT NULL,

            UNIQUE (thread_id, session_id, seq)
         ) STRICT;

         CREATE INDEX IF NOT EXISTS run_events_by_thread ON run_events (thread_id, id);

         DROP TABLE IF EXISTS turn_spans;",
    )?;

    if has_column(transaction, "thread_attachments", "turn")? {
        transaction.execute_batch(
            "CREATE TABLE thread_attachments_rekeyed (
                thread_id TEXT NOT NULL REFERENCES threads (id),
                hash      TEXT NOT NULL REFERENCES attachments (hash),

                PRIMARY KEY (thread_id, hash)
             ) STRICT, WITHOUT ROWID;

             INSERT INTO thread_attachments_rekeyed (thread_id, hash)
             SELECT DISTINCT thread_id, hash FROM thread_attachments;

             DROP TABLE thread_attachments;

             ALTER TABLE thread_attachments_rekeyed RENAME TO thread_attachments;

             CREATE INDEX IF NOT EXISTS thread_attachments_by_hash
                 ON thread_attachments (hash);",
        )?;
    }

    if has_column(transaction, "threads", "prompts")? {
        transaction.execute_batch("ALTER TABLE threads DROP COLUMN prompts;")?;
    }

    Ok(())
}

/// 这张表有没有这一列。表不在时零行，所以这一句同时回答「表在不在」。
fn has_column(transaction: &Transaction<'_>, table: &str, column: &str) -> Result<bool> {
    let found: i64 = transaction.query_row(
        "SELECT count(*) FROM pragma_table_info(?1) WHERE name = ?2",
        rusqlite::params![table, column],
        |row| row.get(0),
    )?;

    Ok(found != 0)
}

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

    /* 记账是一个集合，不是一个最大值。重编号之后「号比 max 小就是跑过了」
    把每一条新迁移都判成已应用，而这个判据自己没有出口：下一条同样跑不了。 */
    let applied: HashSet<i64> = {
        let mut statement = connection.prepare("SELECT version FROM schema_migrations")?;

        statement
            .query_map([], |row| row.get(0))?
            .collect::<std::result::Result<HashSet<i64>, _>>()?
    };

    for (version, name, step) in MIGRATIONS {
        if applied.contains(version) {
            continue;
        }

        let transaction = connection.transaction()?;

        match step {
            Step::Sql(sql) => transaction.execute_batch(sql)?,
            Step::Rust(apply) => apply(&transaction)?,
        }
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
