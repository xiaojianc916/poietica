use std::time::Duration;

use crate::recorder::now_millis;
use poietica_conversation::link::LinkState;

pub(crate) const RELINK_TRIES: u32 = 5;

const DELAY: Duration = Duration::from_millis(500);
const DELAY_CAP: Duration = Duration::from_secs(8);

#[must_use]
pub(crate) fn backoff(attempt: u32) -> Duration {
    let steps = attempt.saturating_sub(1).min(u32::BITS - 1);

    DELAY.saturating_mul(1u32 << steps).min(DELAY_CAP)
}

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

#[must_use]
pub(crate) fn recovered(reason: &str) -> LinkState {
    LinkState::Recovered {
        reason: reason.to_owned(),
    }
}

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
