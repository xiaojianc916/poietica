#![allow(
    clippy::expect_used,
    reason = "failed ledger fixtures must fail the test"
)]
use poietica_conversation::identity::{Seq, ThreadId, TurnId};
use poietica_conversation::ports::{ConversationLedger, PromptDelivery};
use poietica_conversation::turn::{Admission, AdmissionDecision, DeliveryOutcome, DeliveryState};
use poietica_ledger::index::AgentStore;
use poietica_time::test_clock::TestClock;

fn ledger() -> (tempfile::TempDir, AgentStore) {
    let directory = tempfile::tempdir().expect("directory");
    let store = AgentStore::open(
        &directory.path().join("index.sqlite3"),
        TestClock::at_unix_millis(1_700_000_000_000),
    )
    .expect("open");
    (directory, store)
}
fn delivery() -> PromptDelivery {
    PromptDelivery {
        admission: Admission {
            thread: ThreadId::new("thread-1".to_owned()),
            turn: TurnId::new("turn-1".to_owned()),
            prompt: "same intent".to_owned(),
            model: "kimi-k2".to_owned(),
            attachments: Vec::new(),
            skills: Vec::new(),
            submitted_at_unix_millis: 1_700_000_000_000,
        },
        session: "session-1".to_owned(),
    }
}
#[test]
fn repeated_admission_owes_one_delivery_and_records_one_event() {
    let (_directory, ledger) = ledger();
    let requested = delivery();
    assert_eq!(
        ledger.admit(&requested).expect("first"),
        AdmissionDecision::Admitted
    );
    assert_eq!(
        ledger.admit(&requested).expect("repeat"),
        AdmissionDecision::AlreadyAdmitted
    );
    assert_eq!(ledger.unresolved_deliveries().expect("outbox").len(), 1);
    assert_eq!(
        ledger
            .events_after(&requested.admission.thread, Seq::NONE)
            .expect("events")
            .len(),
        1
    );
}
#[test]
fn one_identity_cannot_freeze_two_inputs() {
    let (_directory, ledger) = ledger();
    let mut requested = delivery();
    ledger.admit(&requested).expect("first");
    requested.admission.prompt = "different input".to_owned();
    assert!(ledger.admit(&requested).is_err());
    assert_eq!(ledger.unresolved_deliveries().expect("outbox").len(), 1);
}
#[test]
fn settled_deliveries_do_not_roll_back() {
    let (_directory, ledger) = ledger();
    let requested = delivery();
    let turn = &requested.admission.turn;
    ledger.admit(&requested).expect("admit");
    assert_eq!(
        ledger
            .record_delivery(turn, DeliveryOutcome::Indeterminate)
            .expect("unknown"),
        DeliveryState::Unknown
    );
    assert_eq!(ledger.unresolved_deliveries().expect("pending").len(), 1);
    assert_eq!(
        ledger
            .record_delivery(turn, DeliveryOutcome::Accepted)
            .expect("accept"),
        DeliveryState::Accepted
    );
    assert_eq!(
        ledger
            .record_delivery(turn, DeliveryOutcome::Rejected)
            .expect("late"),
        DeliveryState::Accepted
    );
    assert!(ledger.unresolved_deliveries().expect("settled").is_empty());
}
