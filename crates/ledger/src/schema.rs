//! 库的形状：这一份 schema.sql 就是全部。
//!
//! 这个库不属于任何已发布的版本，所以没有版本号表、没有迁移链、没有历史形状。
//! 改形状 = 改 schema.sql + 删掉用户盘上那个库（见 docs/architecture/data-layout.md）。
//!
//! 语句全是 CREATE ... IF NOT EXISTS：全新库整份建起来，已有的库只在缺表时补建。
//! 没有比对、没有版本推进 —— 那套东西是给已发布的库补形状用的，这里没有已发布的库。

use rusqlite::Connection;

use crate::error::Result;

const SCHEMA: &str = include_str!("schema.sql");

/// 把库摆成 schema.sql 写的形状。`AgentStore::open` 在每次开库时调它。
pub(crate) fn install(connection: &Connection) -> Result<()> {
    connection.execute_batch(SCHEMA)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        reason = "a broken schema must fail the test loudly"
    )]

    use rusqlite::Connection;

    /// 整份 schema 必须是可重复执行的：开一次库要能再开一次。
    #[test]
    fn the_schema_installs_twice_without_complaint() {
        let connection = Connection::open_in_memory().expect("in-memory database");

        super::install(&connection).expect("first install");
        super::install(&connection).expect("second install");
    }

    /// 记住的那几张表都要真的建出来。少一张就是 schema.sql 漏了一段。
    #[test]
    fn every_owned_table_is_created() {
        let connection = Connection::open_in_memory().expect("in-memory database");

        super::install(&connection).expect("install");

        for table in [
            "conversation_events",
            "turn_admissions",
            "delivery_outbox",
            "threads",
            "attachments",
            "thread_attachments",
            "workbench_session",
            "session_disposals",
            "session_usage",
            "token_model_days",
            "automation_state",
            "automation_claims",
        ] {
            let found: i64 = connection
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .expect("lookup");

            assert_eq!(found, 1, "{table} 没有建出来");
        }
    }
}
