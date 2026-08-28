#![allow(
    clippy::unwrap_used,
    reason = "a test proves itself by panicking, so a rejected transition must fail the test"
)]

use poietica_conversation::turn::{
    CancelOrigin, DeliveryOutcome, DeliveryState, TurnCompletion, TurnSignal, TurnState,
};

#[test]
fn happy_path_walks_admitted_to_finished() {
    let admitted = TurnState::Admitted;
    let delivering = admitted.apply(&TurnSignal::DeliveryStarted).unwrap();
    let streaming = delivering.apply(&TurnSignal::DeliveryAccepted).unwrap();
    let finished = streaming
        .apply(&TurnSignal::Finished {
            completion: TurnCompletion::Completed,
        })
        .unwrap();

    assert_eq!(
        finished,
        TurnState::Finished {
            completion: TurnCompletion::Completed
        }
    );
}

#[test]
fn cancellation_collapses_to_one_terminal() {
    let cancelling = TurnState::Streaming
        .apply(&CancelOrigin::User.signal())
        .unwrap();
    let finished = cancelling
        .apply(&TurnSignal::Finished {
            completion: TurnCompletion::Completed,
        })
        .unwrap();

    assert_eq!(
        finished,
        TurnState::Finished {
            completion: TurnCompletion::Cancelled
        }
    );
}

#[test]
fn finished_turns_reject_further_signals() {
    let finished = TurnState::Finished {
        completion: TurnCompletion::Completed,
    };

    assert!(finished.apply(&TurnSignal::DeliveryStarted).is_err());
    assert!(finished.apply(&CancelOrigin::Shutdown.signal()).is_err());
}

#[test]
fn unknown_delivery_can_still_settle() {
    let unknown = DeliveryState::Sent
        .apply(DeliveryOutcome::Indeterminate)
        .unwrap();

    assert_eq!(unknown, DeliveryState::Unknown);
    assert_eq!(
        unknown.apply(DeliveryOutcome::Accepted).unwrap(),
        DeliveryState::Accepted
    );
    assert!(
        DeliveryState::Accepted
            .apply(DeliveryOutcome::Rejected)
            .is_err()
    );
}
