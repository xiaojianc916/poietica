use time::OffsetDateTime;

use crate::WallClock;

/// 操作系统时钟。
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemWallClock;

impl WallClock for SystemWallClock {
    fn now_utc(&self) -> OffsetDateTime {
        OffsetDateTime::now_utc()
    }
}
