//! 可注入的时钟。没有任何地方直接读系统时间，时间相关的判断才可复现。

pub mod test_clock;
pub mod wall_clock;

use core::fmt;

use time::OffsetDateTime;

/// 民用时间。只用于给要离开进程的记录打时间戳。
pub trait WallClock: fmt::Debug + Send + Sync {
    fn now_utc(&self) -> OffsetDateTime;

    fn now_unix_millis(&self) -> i64 {
        let millis = self.now_utc().unix_timestamp_nanos() / 1_000_000;

        i64::try_from(millis).unwrap_or(i64::MAX)
    }
}
