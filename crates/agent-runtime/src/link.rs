//! 这条连接的链路态。
//!
//! 判据住在这里：多久没帧算安静、断了重连几次、等多久、什么错值得再试。
//! 这一套不碰 IO，所以它能脱离 Tauri 与界面单独测；驱动器只管把事实喂进来、
//! 把交回的状态报出去。

use std::time::Duration;

use serde::Serialize;
use tokio::time::Instant;

use crate::error::KapError;
use crate::recorder::now_millis;

/// 一轮在飞时，多久没有一帧就算它安静了。
///
/// 与 codex 的 stream_idle_timeout_ms 同一个判据（codex-rs/model-provider-info
/// 的 "Idle timeout ... before treating the connection as lost"）。差别是这里
/// 不判死只说话：kap 的一轮可能真的在等一个很慢的模型。
pub const STALL_AFTER: Duration = Duration::from_secs(20);

/// 断了之后重连几次，以及可重试的传输错误再试几次。
pub const TRIES: u32 = 5;

/// 第一次等多久；之后翻倍，到 DELAY_CAP 封顶。
const DELAY: Duration = Duration::from_millis(500);
const DELAY_CAP: Duration = Duration::from_secs(8);

/// 屏幕上那一格链路态。判别式与字段名就是线上形状；IPC 面上的镜像住在
/// apps/desktop/src-tauri/src/commands/agent/dto.rs 的 AgentLinkState，serde
/// 属性与这里逐字对齐。改判别式先改这里。
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum LinkState {
    /// 接着，而且在流动。
    Linked,
    /// 链路健在，但这一轮从这一刻起没再来过帧。
    Waiting { since: i64 },
    /// 正在接回来：第几次、共几次、下一次什么时候、上一次为什么没成。
    Retrying {
        attempt: u32,
        of: u32,
        retry_at: i64,
        reason: String,
    },
}

/// 第 attempt 次之前等多久。指数退避，封顶。
///
/// 不加抖动：对端是本机的 kap server，只有一个客户端，没有要错开的惊群 ——
/// opencode 与 kimi 的 25% 抖动防的是多客户端同时撞一个云端。
#[must_use]
pub fn backoff(attempt: u32) -> Duration {
    let steps = attempt.saturating_sub(1).min(u32::BITS - 1);

    DELAY.saturating_mul(1u32 << steps).min(DELAY_CAP)
}

/// 这个错值得再试一次吗。
///
/// 只有传输层：拨号、握手、超时。Envelope 是对端的业务判决（码在 kap 的
/// error-codes.ts 里），同一份请求重发只会换回同一个判决；Validation 与
/// Refused 是本机自己拒的。
#[must_use]
pub fn retryable(error: &KapError) -> bool {
    matches!(
        error,
        KapError::Transport { .. } | KapError::Handshake { .. } | KapError::Timeout { .. }
    )
}

/// 「正在接回来」这一句，全仓只在这里成形。
#[must_use]
pub fn retrying(attempt: u32, wait: Duration, reason: &str) -> LinkState {
    let waited = i64::try_from(wait.as_millis()).unwrap_or(i64::MAX);

    LinkState::Retrying {
        attempt,
        of: TRIES,
        retry_at: now_millis().saturating_add(waited),
        reason: reason.to_owned(),
    }
}

/// 静默判据的持有者。两个钟各管一件事：单调钟定时，墙钟上屏。
pub struct Link {
    quiet_at: Instant,
    seen_at: i64,
    /// 已经说过一句了。说过就不再说第二遍。
    noticed: bool,
}

impl Link {
    #[must_use]
    pub fn new() -> Self {
        Self {
            quiet_at: Instant::now() + STALL_AFTER,
            seen_at: now_millis(),
            noticed: false,
        }
    }

    /// 该说「它安静了」的时刻。
    #[must_use]
    pub fn quiet_at(&self) -> Instant {
        self.quiet_at
    }

    /// 还等着那个时刻吗。
    #[must_use]
    pub fn awaits_quiet(&self) -> bool {
        !self.noticed
    }

    /// 一帧到了。从安静里回来才有话要报。
    pub fn seen(&mut self) -> Option<LinkState> {
        self.seen_at = now_millis();
        self.quiet_at = Instant::now() + STALL_AFTER;

        if !self.noticed {
            return None;
        }

        self.noticed = false;

        Some(LinkState::Linked)
    }

    /// 静默到期。
    pub fn quieted(&mut self) -> LinkState {
        self.noticed = true;

        LinkState::Waiting {
            since: self.seen_at,
        }
    }
}

impl Default for Link {
    fn default() -> Self {
        Self::new()
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
        assert_eq!(backoff(TRIES), DELAY_CAP);
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

    #[test]
    fn a_frame_ends_the_silence_it_reported() {
        let mut link = Link::new();

        assert!(link.awaits_quiet());
        assert!(matches!(link.quieted(), LinkState::Waiting { .. }));
        assert!(!link.awaits_quiet());
        assert!(matches!(link.seen(), Some(LinkState::Linked)));
        assert!(link.awaits_quiet());
        assert!(link.seen().is_none());
    }
}
