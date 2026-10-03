use rusqlite::OptionalExtension;
use time::{Date, Duration as TimeDuration};

use crate::error::Result;
use crate::index::store::AgentStore;

#[derive(Clone, Debug)]
pub struct SessionUsage {
    pub used: i64,
    pub size: i64,
    pub input_other: i64,
    pub input_cache_read: i64,
    pub input_cache_creation: i64,
    /// 花掉这一笔的是哪个模型（provider/id）。缺席即这一份报数没带模型，那一笔只进合计。
    pub model: Option<String>,
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

/// 一天里一个模型花掉的 token。趋势图按它分线。
#[derive(Clone, Debug)]
pub struct ModelDay {
    pub day: String,
    pub model: String,
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
            /*
             * 日账只有一份，按模型拆开的那一份就是它：合计是它的部分和，不另存一行。
             *
             * 没带模型的那一笔落进 UNATTRIBUTED 这一行 —— 编一个模型名比少画一条线更糟，
             * 而把它扔掉会让合计悄悄小于真实花销。趋势图按「不等于 UNATTRIBUTED」滤掉它；
             * 合计（token_days_through）与热力图照算它。
             */
            let model = usage
                .model
                .filter(|model| !model.is_empty())
                .unwrap_or_else(|| UNATTRIBUTED.to_owned());
            transaction.execute(
                "INSERT INTO token_model_days (day, model, tokens) VALUES (?1, ?2, ?3)
                 ON CONFLICT (day, model) DO UPDATE SET tokens = tokens + excluded.tokens",
                rusqlite::params![day.to_string(), model, spent],
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
                    /* 模型不在这张表上：它只在报数到达那一刻知道，落进按模型的日账。 */
                    model: None,
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
        let mut statement = self.connection.prepare_cached(
            "SELECT day, SUM(tokens) FROM token_model_days WHERE day >= ?1 GROUP BY day ORDER BY day",
        )?;
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

    /// 最近 span 天里每个模型各自的日账，由早到晚。没有账的日子与模型不占行。
    pub fn token_model_days(&self, span: i64) -> Result<Vec<ModelDay>> {
        let today = self.clock().now_local_date()?;
        let offset = span.max(1) - 1;
        let earliest = today
            .checked_sub(TimeDuration::days(offset))
            .unwrap_or(Date::MIN);
        let mut statement = self.connection.prepare_cached(
            "SELECT day, model, tokens FROM token_model_days
             WHERE day >= ?1 AND model <> ?2 ORDER BY day, model",
        )?;
        let found = statement
            .query_map(
                rusqlite::params![earliest.to_string(), UNATTRIBUTED],
                |row| {
                    Ok(ModelDay {
                        day: row.get(0)?,
                        model: row.get(1)?,
                        tokens: row.get(2)?,
                    })
                },
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(found)
    }

    /// 最近 span 天里准入了几句话。窗口按时刻切，不按日历格 —— 今天这一格还没过完。
    pub fn messages_since(&self, span: i64) -> Result<i64> {
        let millis = self
            .clock()
            .now_unix_millis()
            .saturating_sub(span.max(1).saturating_mul(MILLIS_PER_DAY));
        let counted: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM turn_admissions WHERE admitted_at_unix_ms >= ?1",
            rusqlite::params![millis],
            |row| row.get(0),
        )?;
        Ok(counted)
    }

    // 对话删除的多表事务由 threads.rs 单点持有。
}

const MILLIS_PER_DAY: i64 = 86_400_000;

/// 没带模型的那一笔在按模型的日账里占的那一格。它不是模型名，所以不会与真名相撞；
/// 趋势图按它过滤，合计把它算进去。
const UNATTRIBUTED: &str = "unattributed";

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
            model: None,
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

    /* 日账只有一份：合计是它的部分和，没带模型的那一笔落进 unattributed 行而不丢。 */
    #[test]
    fn the_model_split_is_the_only_daily_ledger() {
        let root = TempDir::new().expect("temporary directory");
        let clock = TestClock::at_unix_millis(1_700_000_000_000);
        let mut store = AgentStore::open(&root.path().join("usage.sqlite3"), clock).expect("store");
        let day = Date::from_calendar_date(2026, Month::August, 27).expect("date");
        let named = |model: &str| SessionUsage {
            model: Some(model.to_owned()),
            ..usage(100)
        };
        store
            .record_usage_on("a", named("kimi/k2"), day)
            .expect("first");
        store
            .record_usage_on("b", named("kimi/k2"), day)
            .expect("same model");
        store
            .record_usage_on("c", usage(100), day)
            .expect("no model");

        let totals = store.token_days_through(1, day).expect("days");
        assert_eq!(totals.first().expect("recorded day").tokens, 300);
        /* 趋势图这一份不带 unattributed：它不是模型。 */
        let split = store
            .token_model_days(1)
            .expect("model days")
            .into_iter()
            .map(|day| (day.model, day.tokens))
            .collect::<Vec<_>>();
        assert_eq!(split, vec![("kimi/k2".to_owned(), 200)]);
    }

    /* 句子数按时刻切窗口，不按日历格：今天这一格还没过完，数它等于少算半天。 */
    #[test]
    fn the_message_count_reads_the_admission_times() {
        let root = TempDir::new().expect("temporary directory");
        let clock = TestClock::at_unix_millis(1_700_000_000_000);
        let store = AgentStore::open(&root.path().join("usage.sqlite3"), clock).expect("store");
        let admit = |turn: &str, at: i64| {
            store
                .connection
                .execute(
                    "INSERT INTO turn_admissions
                         (turn_id, thread_id, prompt, model, attachments, skills,
                          submitted_at_unix_ms, admitted_at_unix_ms, deliver_as)
                     VALUES (?1, 'thread', 'hi', 'm', '[]', '[]', ?2, ?2, 'turn')",
                    rusqlite::params![turn, at],
                )
                .expect("admission");
        };
        admit("inside", 1_699_999_000_000);
        admit("old", 1_699_000_000_000);

        assert_eq!(store.messages_since(7).expect("count"), 1);
        assert_eq!(store.messages_since(30).expect("count"), 2);
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
