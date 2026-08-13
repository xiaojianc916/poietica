//! 用量：一条会话报到哪儿了，以及每一天用掉多少 token。

use rusqlite::OptionalExtension;
use uuid::Uuid;

use crate::error::Result;
use crate::store::AgentStore;

/// 一条会话此刻的上下文占用。
#[derive(Clone, Copy, Debug)]
pub struct SessionUsage {
    /// 已占用的 token 数。
    pub used: i64,
    /// 上下文窗口总量，token 数。
    pub size: i64,
}

/// 一天用掉多少 token。
#[derive(Clone, Debug)]
pub struct TokenDay {
    /// `YYYY-MM-DD`，本机时区的日历日。
    pub day: String,
    /// 那天累计的 token。
    pub tokens: i64,
}

impl AgentStore {
    /// 记下这条会话刚报的读数，并把增量记进当天的账。
    ///
    /// 增量由上一次的读数算出来。压缩上下文会让读数回落，而那一刻整份上下文
    /// 会被重新送进模型，所以回落时按新读数整笔计入 —— 与 Prometheus 对计数器
    /// 重置的读法同一条规矩。
    ///
    /// 读数与日账同一次事务：分开落，中间崩一次就是一笔永远对不上的账。
    ///
    /// # Errors
    ///
    /// 语句被拒时返回错误。
    pub fn record_usage(&mut self, session_id: &str, usage: SessionUsage) -> Result<()> {
        let transaction = self.connection.transaction()?;

        let counted: Option<i64> = transaction
            .prepare_cached("SELECT used FROM session_usage WHERE session_id = ?1")?
            .query_row(rusqlite::params![session_id], |row| row.get(0))
            .optional()?;

        let spent = match counted {
            Some(previous) if usage.used >= previous => usage.used - previous,
            Some(_fell_back) | None => usage.used,
        };

        transaction.execute(
            "INSERT INTO session_usage (session_id, used, size)
             VALUES (?1, ?2, ?3)
             ON CONFLICT (session_id)
             DO UPDATE SET used = excluded.used, size = excluded.size",
            rusqlite::params![session_id, usage.used, usage.size],
        )?;

        if spent > 0 {
            transaction.execute(
                "INSERT INTO token_days (day, tokens)
                 VALUES (date('now', 'localtime'), ?1)
                 ON CONFLICT (day) DO UPDATE SET tokens = tokens + excluded.tokens",
                rusqlite::params![spent],
            )?;
        }

        transaction.commit()?;

        Ok(())
    }

    /// 这条会话最近报的读数。没报过是 None。
    ///
    /// # Errors
    ///
    /// 查询被拒时返回错误。
    pub fn session_usage(&self, session_id: &str) -> Result<Option<SessionUsage>> {
        let found = self
            .connection
            .prepare_cached("SELECT used, size FROM session_usage WHERE session_id = ?1")?
            .query_row(rusqlite::params![session_id], |row| {
                Ok(SessionUsage {
                    used: row.get(0)?,
                    size: row.get(1)?,
                })
            })
            .optional()?;

        Ok(found)
    }

    /// 最近 span 天的日账，由早到晚。没有账的日子不占行 —— 补齐日历是画图那
    /// 一侧的事（usage-activity.ts 的 spread）。
    ///
    /// # Errors
    ///
    /// 查询被拒时返回错误。
    pub fn token_days(&self, span: i64) -> Result<Vec<TokenDay>> {
        let offset = span.max(1) - 1;

        let mut statement = self.connection.prepare_cached(
            "SELECT day, tokens
               FROM token_days
              WHERE day >= date('now', 'localtime', ?1)
              ORDER BY day",
        )?;

        let found = statement
            .query_map(rusqlite::params![format!("-{offset} days")], |row| {
                Ok(TokenDay {
                    day: row.get(0)?,
                    tokens: row.get(1)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(found)
    }

    /// 松开这条对话握着的那条会话的读数。删对话时与附件、轮次计时一同释放。
    pub(crate) fn release_session_usage(&self, id: Uuid) -> Result<()> {
        self.write(
            "DELETE FROM session_usage
              WHERE session_id IN (SELECT session_id FROM threads WHERE id = ?1)",
            rusqlite::params![id.to_string()],
        )?;

        Ok(())
    }
}
