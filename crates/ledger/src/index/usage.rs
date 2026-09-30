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
    /// 上下文构成。缺席即那一份报数没带构成，屏幕退成只画总条。
    pub breakdown: Option<UsageBreakdown>,
}

/// 上下文构成的七格，与 agent 状态行里显示的那份逐格对应。
///
/// 七格同进同出：屏幕上缺一格就画不出完整的一条，报半份等于报了个错的分布。
#[derive(Clone, Copy, Debug)]
pub struct UsageBreakdown {
    pub system: i64,
    pub system_context: i64,
    pub tools: i64,
    pub skills: i64,
    pub messages: i64,
    pub free: i64,
    pub buffer: i64,
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
        let (system, system_context, tools, skills, messages, free, buffer) = match usage.breakdown
        {
            Some(breakdown) => (
                Some(breakdown.system),
                Some(breakdown.system_context),
                Some(breakdown.tools),
                Some(breakdown.skills),
                Some(breakdown.messages),
                Some(breakdown.free),
                Some(breakdown.buffer),
            ),
            None => (None, None, None, None, None, None, None),
        };
        transaction.execute(
            "INSERT INTO session_usage
                 (session_id, used, size, input_other, input_cache_read, input_cache_creation,
                  breakdown_system, breakdown_system_context, breakdown_tools, breakdown_skills,
                  breakdown_messages, breakdown_free, breakdown_buffer)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT (session_id)
             DO UPDATE SET used = excluded.used, size = excluded.size,
                 input_other = excluded.input_other,
                 input_cache_read = excluded.input_cache_read,
                 input_cache_creation = excluded.input_cache_creation,
                 breakdown_system = excluded.breakdown_system,
                 breakdown_system_context = excluded.breakdown_system_context,
                 breakdown_tools = excluded.breakdown_tools,
                 breakdown_skills = excluded.breakdown_skills,
                 breakdown_messages = excluded.breakdown_messages,
                 breakdown_free = excluded.breakdown_free,
                 breakdown_buffer = excluded.breakdown_buffer",
            rusqlite::params![
                session_id,
                usage.used,
                usage.size,
                usage.input_other,
                usage.input_cache_read,
                usage.input_cache_creation,
                system,
                system_context,
                tools,
                skills,
                messages,
                free,
                buffer,
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
                "SELECT used, size, input_other, input_cache_read, input_cache_creation,
                        breakdown_system, breakdown_system_context, breakdown_tools, breakdown_skills,
                        breakdown_messages, breakdown_free, breakdown_buffer
                 FROM session_usage WHERE session_id = ?1",
            )?
            .query_row(rusqlite::params![session_id], |row| {
                /* 七列同进同出：只认七格齐全的那一份，半份当没有。 */
                let parts = (
                    row.get::<_, Option<i64>>(5)?,
                    row.get::<_, Option<i64>>(6)?,
                    row.get::<_, Option<i64>>(7)?,
                    row.get::<_, Option<i64>>(8)?,
                    row.get::<_, Option<i64>>(9)?,
                    row.get::<_, Option<i64>>(10)?,
                    row.get::<_, Option<i64>>(11)?,
                );

                Ok(SessionUsage {
                    used: row.get(0)?,
                    size: row.get(1)?,
                    input_other: row.get(2)?,
                    input_cache_read: row.get(3)?,
                    input_cache_creation: row.get(4)?,
                    breakdown: match parts {
                        (
                            Some(system),
                            Some(system_context),
                            Some(tools),
                            Some(skills),
                            Some(messages),
                            Some(free),
                            Some(buffer),
                        ) => Some(UsageBreakdown {
                            system,
                            system_context,
                            tools,
                            skills,
                            messages,
                            free,
                            buffer,
                        }),
                        _ => None,
                    },
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

    use super::{AgentStore, SessionUsage, UsageBreakdown};

    fn usage(used: i64) -> SessionUsage {
        SessionUsage {
            used,
            size: 200,
            input_other: 1,
            input_cache_read: 2,
            input_cache_creation: 3,
            breakdown: None,
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

    /* 七格同进同出：半份构成不算一份，读回来必须是「没有」，不能是七个 0。 */
    #[test]
    fn a_breakdown_round_trips_only_when_all_seven_boxes_are_there() {
        let root = TempDir::new().expect("temporary directory");
        let clock = TestClock::at_unix_millis(1_700_000_000_000);
        let mut store = AgentStore::open(&root.path().join("usage.sqlite3"), clock).expect("store");

        store.record_usage("session", usage(100)).expect("plain");
        let plain = store
            .session_usage("session")
            .expect("read")
            .expect("recorded");
        assert!(plain.breakdown.is_none());

        store
            .record_usage(
                "session",
                SessionUsage {
                    breakdown: Some(UsageBreakdown {
                        system: 7,
                        system_context: 8,
                        tools: 9,
                        skills: 10,
                        messages: 11,
                        free: 12,
                        buffer: 13,
                    }),
                    ..usage(150)
                },
            )
            .expect("with breakdown");
        let stored = store
            .session_usage("session")
            .expect("read")
            .expect("recorded");
        let breakdown = stored.breakdown.expect("all seven boxes present");
        assert_eq!(breakdown.system, 7);
        assert_eq!(breakdown.buffer, 13);
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
