use crate::AutomationError;
use chrono::{DateTime, SecondsFormat, Utc};
use chrono_tz::Tz;
use croner::{
    Cron,
    errors::CronError,
    parser::{CronParser, Seconds},
};
use serde::{Deserialize, Serialize};
use specta::Type;
use thiserror::Error;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Type, PartialEq, Eq, Error)]
#[serde(rename_all = "camelCase")]
pub enum ScheduleProblem {
    #[error("读不懂这段 crontab 表达式")]
    Unreadable,
    #[error("这段表达式没有下一次运行")]
    NeverRuns,
    #[error("最小调度粒度为一分钟：秒字段只能命中一个值")]
    TooFrequent,
    #[error("不是有效的 IANA 时区")]
    TimeZone,
}
#[derive(Clone, Debug, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SchedulePreview {
    pub next_run_at: Option<String>,
    pub problem: Option<ScheduleProblem>,
}

fn parse(expression: &str) -> Result<Cron, ScheduleProblem> {
    if expression.contains('?') {
        return Err(ScheduleProblem::Unreadable);
    }
    let cron = CronParser::builder()
        .seconds(Seconds::Optional)
        .sloppy_ranges(true)
        .build()
        .parse(expression)
        .map_err(|_| ScheduleProblem::Unreadable)?;
    let mut seconds = 0;
    for second in 0..60 {
        if cron
            .pattern
            .second_match(second)
            .map_err(|_| ScheduleProblem::Unreadable)?
        {
            seconds += 1;
        }
    }
    if seconds != 1 {
        return Err(ScheduleProblem::TooFrequent);
    }
    Ok(cron)
}

pub fn next_after(
    expression: Option<&str>,
    time_zone: &str,
    now: i64,
) -> Result<Option<String>, ScheduleProblem> {
    let zone: Tz = time_zone.parse().map_err(|_| ScheduleProblem::TimeZone)?;
    let Some(expression) = expression else {
        return Ok(None);
    };
    let origin = DateTime::<Utc>::from_timestamp_millis(now)
        .ok_or(ScheduleProblem::Unreadable)?
        .with_timezone(&zone);
    match parse(expression)?.find_next_occurrence(&origin, false) {
        Ok(next) => Ok(Some(
            next.with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true),
        )),
        Err(CronError::TimeSearchLimitExceeded) => Ok(None),
        Err(_) => Err(ScheduleProblem::Unreadable),
    }
}

#[must_use]
pub fn preview(expression: Option<&str>, time_zone: &str, now: i64) -> SchedulePreview {
    match next_after(expression, time_zone, now) {
        Ok(None) if expression.is_some() => SchedulePreview {
            next_run_at: None,
            problem: Some(ScheduleProblem::NeverRuns),
        },
        Ok(next_run_at) => SchedulePreview {
            next_run_at,
            problem: None,
        },
        Err(problem) => SchedulePreview {
            next_run_at: None,
            problem: Some(problem),
        },
    }
}

pub fn stamp(now: i64) -> Result<String, AutomationError> {
    DateTime::<Utc>::from_timestamp_millis(now)
        .map(|at| at.to_rfc3339_opts(SecondsFormat::Millis, true))
        .ok_or_else(|| AutomationError::Data("时间戳超出范围".to_owned()))
}
pub fn millis(value: &str) -> Result<i64, AutomationError> {
    DateTime::parse_from_rfc3339(value)
        .map(|at| at.timestamp_millis())
        .map_err(|error| AutomationError::Data(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn minute_policy_checks_all_seconds_not_two_future_samples() {
        assert_eq!(
            preview(Some("0,30 0 0 1 1 *"), "UTC", 0).problem,
            Some(ScheduleProblem::TooFrequent)
        );
        assert!(preview(Some("59 * * * * *"), "UTC", 0).problem.is_none());
        assert!(preview(Some("0/10 * * * *"), "UTC", 0).problem.is_none());
    }
    #[test]
    fn explicit_zone_and_missed_slots() -> Result<(), AutomationError> {
        let now = millis("2026-01-04T10:00:00+08:00")?;
        assert_eq!(
            next_after(Some("0 9 * * *"), "Asia/Shanghai", now)?.as_deref(),
            Some("2026-01-05T01:00:00.000Z")
        );
        assert_eq!(
            preview(Some("0 0 31 2 *"), "UTC", now).problem,
            Some(ScheduleProblem::NeverRuns)
        );
        assert_eq!(
            preview(None, "not/a-zone", now).problem,
            Some(ScheduleProblem::TimeZone)
        );
        Ok(())
    }
    #[test]
    fn dst_fixed_time_runs_once_and_gap_uses_first_real_instant() -> Result<(), AutomationError> {
        let before = millis("2025-10-26T00:00:00Z")?;
        let first = next_after(Some("30 2 * * *"), "Europe/Stockholm", before)?
            .ok_or(AutomationError::Missing)?;
        assert_eq!(first, "2025-10-26T00:30:00.000Z");
        assert_eq!(
            next_after(Some("30 2 * * *"), "Europe/Stockholm", millis(&first)?)?.as_deref(),
            Some("2025-10-27T01:30:00.000Z")
        );
        assert_eq!(
            next_after(
                Some("30 2 * * *"),
                "Europe/Stockholm",
                millis("2025-03-30T00:59:59Z")?
            )?
            .as_deref(),
            Some("2025-03-30T01:00:00.000Z")
        );
        Ok(())
    }
}
