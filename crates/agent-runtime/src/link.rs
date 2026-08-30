//! 这条连接的链路态。
//!
//! 判据住在这里：断了重连几次、等多久、什么错值得再试。
//! 这一套不碰 IO，所以它能脱离 Tauri 与界面单独测；驱动器只管把事实喂进来、
//! 把交回的状态报出去。

use std::time::Duration;

use crate::recorder::now_millis;
use poietica_conversation::link::LinkState;

/// 断了之后重连几次。第一次立刻拨，之后每失败一次退避一档。
pub(crate) const RELINK_TRIES: u32 = 5;

/// 第一次失败之后等多久；之后翻倍，到 DELAY_CAP 封顶。
const DELAY: Duration = Duration::from_millis(500);
const DELAY_CAP: Duration = Duration::from_secs(8);

/// 第 attempt 次失败之后等多久。指数退避，封顶。
///
/// 不加抖动：对端是本机的 kap server，只有一个客户端，没有要错开的惊群。
#[must_use]
pub(crate) fn backoff(attempt: u32) -> Duration {
    let steps = attempt.saturating_sub(1).min(u32::BITS - 1);

    DELAY.saturating_mul(1u32 << steps).min(DELAY_CAP)
}

/// 「正在接回来」这一句，全仓只在这里成形。
#[must_use]
pub(crate) fn retrying(attempt: u32, wait: Duration, reason: &str) -> LinkState {
    let waited = i64::try_from(wait.as_millis()).unwrap_or(i64::MAX);

    LinkState::Retrying {
        attempt,
        of: RELINK_TRIES,
        retry_at: now_millis().saturating_add(waited),
        reason: reason.to_owned(),
    }
}

/// 「接回来了」这一句，全仓只在这里成形。
#[must_use]
pub(crate) fn recovered(reason: &str) -> LinkState {
    LinkState::Recovered {
        reason: reason.to_owned(),
    }
}

/// 「接不回来了」这一句，全仓只在这里成形。
#[must_use]
pub(crate) fn severed(attempts: u32, reason: &str) -> LinkState {
    LinkState::Severed {
        attempts,
        reason: reason.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_then_stops_at_the_cap() {
        assert_eq!(backoff(1), DELAY);
        assert_eq!(backoff(2), Duration::from_secs(1));
        assert_eq!(backoff(4), Duration::from_secs(4));
        assert_eq!(backoff(u32::MAX), DELAY_CAP);
    }
}
