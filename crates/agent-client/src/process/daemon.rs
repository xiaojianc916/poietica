//! 守护进程的意图与相位。

use std::time::Duration;

use crate::recorder::now_millis;

const RESTART_TRIES: u32 = 5;

const HEALTHY_RUN: Duration = Duration::from_mins(1);

const BACKOFF_STEP: Duration = Duration::from_millis(500);
const BACKOFF_CAP: Duration = Duration::from_secs(8);

/// 第 attempt 次重启之前等多久：翻倍，封顶。
#[must_use]
fn backoff(attempt: u32) -> Duration {
    let steps = attempt.saturating_sub(1).min(u32::BITS - 1);

    BACKOFF_STEP.saturating_mul(1u32 << steps).min(BACKOFF_CAP)
}

/// 用户要的状态。真相在 settings.json 的 general.daemon，这里是它在进程内的投影。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DaemonIntent {
    Running,
    Stopped,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DaemonPhase {
    Stopped,
    Running,
    Restarting {
        attempt: u32,
        of: u32,
        retry_at: i64,
        reason: String,
    },
    Failed {
        attempts: u32,
        reason: String,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Reaction {
    Idle,
    StartAfter(Duration),
    Stop,
}

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
    pub const fn phase(&self) -> &DaemonPhase {
        &self.phase
    }

    /// 拨开不起进程（冷启动的账由第一次对话付）；拨关要当场停。
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

    pub fn note_started(&mut self) {
        self.started_at = Some(now_millis());
        self.phase = DaemonPhase::Running;
    }

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
    use std::time::Duration;

    use super::{Daemon, DaemonIntent, DaemonPhase, RESTART_TRIES, Reaction, backoff};

    #[test]
    fn backoff_doubles_then_stops_at_the_cap() {
        assert_eq!(backoff(1), Duration::from_millis(500));
        assert_eq!(backoff(2), Duration::from_secs(1));
        assert_eq!(backoff(4), Duration::from_secs(4));
        assert_eq!(backoff(u32::MAX), Duration::from_secs(8));
    }

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
