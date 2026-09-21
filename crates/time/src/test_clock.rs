use time::OffsetDateTime;

use crate::WallClock;

/// 停在构造时那一刻的时钟：测试里「时间冻结在某点」就够用。
#[derive(Debug)]
pub struct TestClock {
    unix_millis: i64,
}

impl TestClock {
    pub fn at_unix_millis(start: i64) -> Self {
        Self { unix_millis: start }
    }
}

impl WallClock for TestClock {
    fn now_utc(&self) -> OffsetDateTime {
        OffsetDateTime::UNIX_EPOCH + time::Duration::milliseconds(self.unix_millis)
    }

    /// 冻结在那一刻的 UTC 日期：测试不该跟着跑测试那台机器的时区走。
    fn now_local_date(&self) -> Result<time::Date, time::error::IndeterminateOffset> {
        Ok(self.now_utc().date())
    }
}
