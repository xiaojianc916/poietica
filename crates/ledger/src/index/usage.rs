use rusqlite::OptionalExtension;
use time::{Date, Duration as TimeDuration};

use crate::error::Result;
use crate::index::store::AgentStore;

#[derive(Clone, Copy, Debug)]
pub struct SessionUsage {
    pub used: i64,
    pub size: i64,
    pub input_other: i64,
    pub input_cache_read: i64,
    pub input_cache_creation: i64,
}

#[derive(Clone, Debug)]
pub struct TokenDay {
    pub day: String,
    pub tokens: i64,
}

impl AgentStore {
    pub fn record_usage(&mut self, session_id: &str, usage: SessionUsage) -> Result<()> {
        let day = self.clock().now_local_date()?;
        self.record_usage_on(session_id, usage, day)
    }

    fn record_usage_on(&mut self, session_id: &str, usage: SessionUsage, day: Date) -> Result<()> {
        let transaction = self.connection.transaction()?;
        let counted: Option<i64> = transaction
            .prepare_cached("SELECT used FROM session_usage WHERE session_id = ?1")?
            .query_row(rusqlite::params![session_id], |row| row.get(0))
            .optional()?;
        let spent = match counted {
            Some(previous) if usage.used >= previous => usage.used - previous,
            _ => usage.used,
        };
        transaction.execute(
            "INSERT INTO session_usage
                 (session_id, used, size, input_other, input_cache_read, input_cache_creation)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (session_id)
             DO UPDATE SET used = excluded.used, size = excluded.size,
                 input_other = excluded.input_other,
                 input_cache_read = excluded.input_cache_read,
                 input_cache_creation = excluded.input_cache_creation",
            rusqlite::params![
                session_id,
                usage.used,
                usage.size,
                usage.input_other,
                usage.input_cache_read,
                usage.input_cache_creation,
            ],
        )?;
        if spent > 0 {
            transaction.execute(
                "INSERT INTO token_days (day, tokens) VALUES (?1, ?2)
                 ON CONFLICT (day) DO UPDATE SET tokens = tokens + excluded.tokens",
                rusqlite::params![day.to_string(), spent],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn session_usage(&self, session_id: &str) -> Result<Option<SessionUsage>> {
        let found = self
            .connection
            .prepare_cached(
                "SELECT used, size, input_other, input_cache_read, input_cache_creation
                 FROM session_usage WHERE session_id = ?1",
            )?
            .query_row(rusqlite::params![session_id], |row| {
                Ok(SessionUsage {
                    used: row.get(0)?,
                    size: row.get(1)?,
                    input_other: row.get(2)?,
                    input_cache_read: row.get(3)?,
                    input_cache_creation: row.get(4)?,
                })
            })
            .optional()?;

        Ok(found)
    }

    pub fn token_days(&self, span: i64) -> Result<Vec<TokenDay>> {
        let today = self.clock().now_local_date()?;
        self.token_days_through(span, today)
    }

    fn token_days_through(&self, span: i64, today: Date) -> Result<Vec<TokenDay>> {
        let offset = span.max(1) - 1;
        let earliest = today
            .checked_sub(TimeDuration::days(offset))
            .unwrap_or(Date::MIN);
        let mut statement = self
            .connection
            .prepare_cached("SELECT day, tokens FROM token_days WHERE day >= ?1 ORDER BY day")?;
        let found = statement
            .query_map(rusqlite::params![earliest.to_string()], |row| {
                Ok(TokenDay {
                    day: row.get(0)?,
                    tokens: row.get(1)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(found)
    }

    // 对话删除的多表事务由 threads.rs 单点持有。
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, reason = "a broken test fixture must fail loudly")]

    use poietica_time::WallClock;
    use poietica_time::test_clock::TestClock;
    use tempfile::TempDir;
    use time::{Date, Month};

    use super::{AgentStore, SessionUsage};

    fn usage(used: i64) -> SessionUsage {
        SessionUsage {
            used,
            size: 200,
            input_other: 1,
            input_cache_read: 2,
            input_cache_creation: 3,
        }
    }

    #[test]
    fn usage_day_is_injected_once_and_counter_resets_are_counted() {
        let root = TempDir::new().expect("temporary directory");
        let clock = TestClock::at_unix_millis(1_700_000_000_000);
        let mut store = AgentStore::open(&root.path().join("usage.sqlite3"), clock).expect("store");
        let day = Date::from_calendar_date(2026, Month::August, 27).expect("date");
        store
            .record_usage_on("session", usage(100), day)
            .expect("first");
        store
            .record_usage_on("session", usage(150), day)
            .expect("increase");
        store
            .record_usage_on("session", usage(20), day)
            .expect("reset");
        let days = store.token_days_through(1, day).expect("days");
        assert_eq!(days.len(), 1);
        assert_eq!(days.first().expect("recorded day").tokens, 170);
    }

    /* 今天这一格必须来自注入的时钟：直接读系统时间的话，跨时区的那一笔会记到隔壁那一天。 */
    #[test]
    fn the_recorded_day_comes_from_the_injected_clock() {
        let root = TempDir::new().expect("temporary directory");
        let clock = TestClock::at_unix_millis(1_700_000_000_000);
        let expected = clock.now_local_date().expect("local date");
        let mut store = AgentStore::open(&root.path().join("usage.sqlite3"), clock).expect("store");
        store.record_usage("session", usage(100)).expect("recorded");
        let days = store.token_days(1).expect("days");
        assert_eq!(days.len(), 1);
        assert_eq!(
            days.first().expect("recorded day").day,
            expected.to_string()
        );
    }
}
