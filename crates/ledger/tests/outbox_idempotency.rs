use poietica_conversation::identity::{ThreadId, TurnId};
use poietica_conversation::ports::ConversationLedger;
use poietica_conversation::turn::{Admission, AdmissionDecision, DeliveryOutcome, DeliveryState};
use poietica_ledger::SqliteLedger;
use poietica_ledger::connection::open_in_memory;
use poietica_time::test_clock::TestClock;

fn ledger() -> SqliteLedger<TestClock> {
    let ledger = SqliteLedger::new(
        open_in_memory().expect("in-memory ledger opens"),
        TestClock::at_unix_millis(1_700_000_000_000),
    );

    ledger.migrate().expect("migrations apply");

    ledger
}

#[test]
fn resubmitting_a_turn_never_owes_a_second_delivery() {
    let ledger = ledger();
    let thread = ThreadId::new("thread-1".to_owned());
    let turn = TurnId::new("turn-1".to_owned());
    let admission = Admission {
        thread: thread.clone(),
        turn: turn.clone(),
        prompt: "same intent".to_owned(),
        model: "kimi-k2".to_owned(),
        attachments: Vec::new(),
        submitted_at_unix_millis: 1_700_000_000_000,
    };

    assert_eq!(
        ledger.admit(&admission).expect("first admit"),
        AdmissionDecision::Admitted
    );
    assert_eq!(
        ledger.admit(&admission).expect("second admit"),
        AdmissionDecision::AlreadyAdmitted
    );
    assert_eq!(ledger.unresolved_deliveries().expect("unresolved").len(), 1);
    assert_eq!(
        ledger.delivery_state(&turn).expect("state"),
        Some(DeliveryState::Pending)
    );
}

#[test]
fn settled_deliveries_do_not_roll_back() {
    let ledger = ledger();
    let thread = ThreadId::new("thread-1".to_owned());
    let turn = TurnId::new("turn-1".to_owned());

    ledger
        .admit(&Admission {
            thread,
            turn: turn.clone(),
            prompt: "one turn".to_owned(),
            model: "kimi-k2".to_owned(),
            attachments: Vec::new(),
            submitted_at_unix_millis: 1_700_000_000_000,
        })
        .expect("admit");

    assert_eq!(
        ledger
            .record_delivery(&turn, DeliveryOutcome::Indeterminate)
            .expect("unknown"),
        DeliveryState::Unknown
    );
    assert_eq!(ledger.unresolved_deliveries().expect("unresolved").len(), 1);
    assert_eq!(
        ledger
            .record_delivery(&turn, DeliveryOutcome::Accepted)
            .expect("accepted"),
        DeliveryState::Accepted
    );
    assert_eq!(
        ledger
            .record_delivery(&turn, DeliveryOutcome::Rejected)
            .expect("late rejection"),
        DeliveryState::Accepted
    );
    assert!(
        ledger
            .unresolved_deliveries()
            .expect("unresolved")
            .is_empty()
    );
}
