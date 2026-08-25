//! 这条连接的链路态。
//!
//! 判据住在这里：断了重连几次、等多久、什么错值得再试。
//! 这一套不碰 IO，所以它能脱离 Tauri 与界面单独测；驱动器只管把事实喂进来、
//! 把交回的状态报出去。

use std::time::Duration;

use serde::Serialize;

use crate::error::KapError;
use crate::recorder::now_millis;

/// 断了之后重连几次。第一次立刻拨，之后每失败一次退避一档。
pub(crate) const RELINK_TRIES: u32 = 5;

/// 第一次失败之后等多久；之后翻倍，到 DELAY_CAP 封顶。
const DELAY: Duration = Duration::from_millis(500);
const DELAY_CAP: Duration = Duration::from_secs(8);

/// 屏幕上那一格链路态。判别式与字段名就是线上形状；它作为 RunFrame::LinkChanged
/// 的载荷落库（frame.rs），重放一条对话就原样再演一遍。改判别式先改这里。
///
/// 只说链路的事。「模型半天不说话」是这一轮的事，屏幕上由轮次封条的
/// 秒表说，不从这里冒充一次断线。
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum LinkState {
    /// 正在接回来：第几次、共几次、下一次什么时候、上一次为什么没成。
    /// retry_at 等于此刻表示正在拨号，没有倒计时可读。
    Retrying {
        attempt: u32,
        of: u32,
        retry_at: i64,
        reason: String,
    },
    /// 接回来了，以及这一轮是被什么打断的。
    Recovered { reason: String },
    /// 试到头了，接不回来。这一轮的结局由帧记，链路态只报自己。
    Severed { attempts: u32, reason: String },
}

/// 第 attempt 次失败之后等多久。指数退避，封顶。
///
/// 不加抖动：对端是本机的 kap server，只有一个客户端，没有要错开的惊群。
#[must_use]
pub(crate) fn backoff(attempt: u32) -> Duration {
    let steps = attempt.saturating_sub(1).min(u32::BITS - 1);

    DELAY.saturating_mul(1u32 << steps).min(DELAY_CAP)
}

/// 这个错值得再试一次吗。
///
/// 只有传输层：拨号、握手、超时。Envelope 是对端的业务判决（码在 kap 的
/// error-codes.ts 里），同一份请求重发只会换回同一个判决；Validation 与
/// Refused 是本机自己拒的。
#[must_use]
pub(crate) fn retryable(error: &KapError) -> bool {
    matches!(
        error,
        KapError::Transport { .. } | KapError::Handshake { .. } | KapError::Timeout { .. }
    )
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
    use crate::error::Refusal;

    #[test]
    fn backoff_doubles_then_stops_at_the_cap() {
        assert_eq!(backoff(1), DELAY);
        assert_eq!(backoff(2), Duration::from_secs(1));
        assert_eq!(backoff(4), Duration::from_secs(4));
        assert_eq!(backoff(u32::MAX), DELAY_CAP);
    }

    #[test]
    fn only_transport_failures_are_worth_another_try() {
        assert!(retryable(&KapError::Transport {
            message: String::new()
        }));
        assert!(!retryable(&KapError::Envelope {
            code: 40101,
            message: String::new()
        }));
        assert!(!retryable(&KapError::Refused(Refusal::Busy)));
    }
}
