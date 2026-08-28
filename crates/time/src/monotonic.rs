use core::time::Duration;
use std::time::Instant;

use crate::MonotonicClock;

/// 自创建起流逝的时间。系统时间被改动不影响它。
#[derive(Debug, Clone, Copy)]
pub struct ProcessMonotonicClock {
    started: Instant,
}

impl ProcessMonotonicClock {
    pub fn start() -> Self {
        Self {
            started: Instant::now(),
        }
    }
}

impl MonotonicClock for ProcessMonotonicClock {
    fn elapsed(&self) -> Duration {
        self.started.elapsed()
    }
}
