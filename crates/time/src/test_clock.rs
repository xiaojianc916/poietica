use core::time::Duration;
use std::sync::atomic::{AtomicI64, Ordering};

use time::OffsetDateTime;

use crate::{MonotonicClock, WallClock};

/// 由测试推动的时钟：只有 advance 能让它走。用原子量而不是锁，
/// 所以没有中毒回退这条路径。
#[derive(Debug)]
pub struct TestClock {
    origin_unix_millis: i64,
    unix_millis: AtomicI64,
}

impl TestClock {
    pub fn at_unix_millis(start: i64) -> Self {
        Self {
            origin_unix_millis: start,
            unix_millis: AtomicI64::new(start),
        }
    }

    pub fn advance(&self, by: Duration) {
        let millis = i64::try_from(by.as_millis()).unwrap_or(i64::MAX);

        self.unix_millis.fetch_add(millis, Ordering::Relaxed);
    }
}

impl WallClock for TestClock {
    fn now_utc(&self) -> OffsetDateTime {
        OffsetDateTime::UNIX_EPOCH
            + time::Duration::milliseconds(self.unix_millis.load(Ordering::Relaxed))
    }
}

impl MonotonicClock for TestClock {
    fn elapsed(&self) -> Duration {
        let advanced = self.unix_millis.load(Ordering::Relaxed) - self.origin_unix_millis;

        Duration::from_millis(u64::try_from(advanced).unwrap_or(0))
    }
}
