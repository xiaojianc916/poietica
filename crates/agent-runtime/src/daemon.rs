//! 守护进程的意图与相位。
//!
//! 这一套不碰 IO、不认识宿主，所以它能脱离 Tauri 与界面单独测；执行者只把事实
//! 喂进来，按交回的反应动作。退避不在这里重造：进程重起与链路重连用同一条曲线
//! （link.rs 的 backoff）。

use std::time::Duration;

use crate::link::backoff;
use crate::recorder::now_millis;

/// 进程死掉之后重起几次。到顶即封版，不无限重试。
const RESTART_TRIES: u32 = 5;

/// 起来之后活满这么久就算健康，重试计数归零。只在退出时对账，不占一个定时器。
const HEALTHY_RUN: Duration = Duration::from_secs(60);

/// 用户要的状态。真相在 settings.json 的 general.daemon，这里是它在进程内的投影。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DaemonIntent {
    Running,
    Stopped,
}

/// 此刻的事实。
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DaemonPhase {
    /// 没有进程，也不该有。
    Stopped,
    /// 有进程。
    Running,
    /// 进程死了，等着再起：第几次、共几次、什么时候、上一次为什么。
    Restarting {
        attempt: u32,
        of: u32,
        retry_at: i64,
        reason: String,
    },
    /// 试到头了。再起要用户自己拨一次开关 —— 一个自己永远重试的进程没有终态。
    Failed { attempts: u32, reason: String },
}

/// 执行者该做什么。只有这三种，没有第四种。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Reaction {
    Idle,
    StartAfter(Duration),
    Stop,
}

/// 守护进程的状态机。
#[derive(Debug)]
pub struct Daemon {
    intent: DaemonIntent,
    phase: DaemonPhase,
    attempt: u32,
    started_at: Option<i64>,
}

impl Daemon {
    #[must_use]
    pub const fn new(intent: DaemonIntent) -> Self {
        Self {
            intent,
            phase: DaemonPhase::Stopped,
            attempt: 0,
            started_at: None,
        }
    }

    #[must_use]
    pub const fn intent(&self) -> DaemonIntent {
        self.intent
    }

    #[must_use]
    pub const fn phase(&self) -> &DaemonPhase {
        &self.phase
    }

    /// 用户拨了开关。
    ///
    /// 拨开不起进程：冷启动的账由第一次对话付，判据与 AgentRuntime::new 的
    /// 「不在开机时起 agent」逐字相同。拨关要当场停 —— 一个关掉了还在跑的
    /// 后台进程，是开关在撒谎。
    pub fn set_intent(&mut self, intent: DaemonIntent) -> Reaction {
        if self.intent == intent {
            return Reaction::Idle;
        }

        self.intent = intent;
        self.attempt = 0;
        self.started_at = None;
        self.phase = DaemonPhase::Stopped;

        match intent {
            DaemonIntent::Running => Reaction::Idle,
            DaemonIntent::Stopped => Reaction::Stop,
        }
    }

    /// 进程起来了。所有起进程的路都经过 ensure_session，所以这句话只有一处调用。
    pub fn note_started(&mut self) {
        self.started_at = Some(now_millis());
        self.phase = DaemonPhase::Running;
    }

    /// 进程没了。
    pub fn note_exited(&mut self, reason: &str) -> Reaction {
        let healthy = i64::try_from(HEALTHY_RUN.as_millis()).unwrap_or(i64::MAX);

        if self
            .started_at
            .is_some_and(|at| now_millis().saturating_sub(at) >= healthy)
        {
            self.attempt = 0;
        }

        self.started_at = None;

        if self.intent == DaemonIntent::Stopped {
            self.phase = DaemonPhase::Stopped;
            return Reaction::Idle;
        }

        if self.attempt >= RESTART_TRIES {
            self.phase = DaemonPhase::Failed {
                attempts: self.attempt,
                reason: reason.to_owned(),
            };
            return Reaction::Idle;
        }

        self.attempt = self.attempt.saturating_add(1);

        let wait = backoff(self.attempt);
        let waited = i64::try_from(wait.as_millis()).unwrap_or(i64::MAX);

        self.phase = DaemonPhase::Restarting {
            attempt: self.attempt,
            of: RESTART_TRIES,
            retry_at: now_millis().saturating_add(waited),
            reason: reason.to_owned(),
        };

        Reaction::StartAfter(wait)
    }
}

#[cfg(test)]
mod tests {
    use super::{Daemon, DaemonIntent, DaemonPhase, RESTART_TRIES, Reaction};

    #[test]
    fn a_stopped_daemon_does_not_bring_the_process_back() {
        let mut daemon = Daemon::new(DaemonIntent::Stopped);

        assert_eq!(daemon.note_exited("gone"), Reaction::Idle);
        assert_eq!(daemon.phase(), &DaemonPhase::Stopped);
    }

    #[test]
    fn restarts_back_off_and_then_stop_asking() {
        let mut daemon = Daemon::new(DaemonIntent::Running);

        for _ in 0..RESTART_TRIES {
            assert!(matches!(
                daemon.note_exited("crash"),
                Reaction::StartAfter(_)
            ));
        }

        assert_eq!(daemon.note_exited("crash"), Reaction::Idle);
        assert!(matches!(daemon.phase(), DaemonPhase::Failed { .. }));
    }

    #[test]
    fn a_healthy_run_forgives_the_earlier_failures() {
        let mut daemon = Daemon::new(DaemonIntent::Running);

        for _ in 0..RESTART_TRIES {
            let _asked = daemon.note_exited("crash");
        }

        daemon.note_started();
        assert_eq!(daemon.phase(), &DaemonPhase::Running);
    }

    #[test]
    fn turning_the_switch_off_asks_for_a_stop_and_clears_a_verdict() {
        let mut daemon = Daemon::new(DaemonIntent::Running);

        for _ in 0..=RESTART_TRIES {
            let _asked = daemon.note_exited("crash");
        }

        assert!(matches!(daemon.phase(), DaemonPhase::Failed { .. }));
        assert_eq!(daemon.set_intent(DaemonIntent::Stopped), Reaction::Stop);
        assert_eq!(daemon.set_intent(DaemonIntent::Running), Reaction::Idle);
        assert_eq!(daemon.phase(), &DaemonPhase::Stopped);
    }
}
