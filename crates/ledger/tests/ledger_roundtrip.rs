#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    reason = "a test proves itself by panicking, so a failing ledger step must fail the test"
)]

use poietica_conversation::event::ConversationEvent;
use poietica_conversation::identity::{Seq, ThreadId, TurnId};
use poietica_conversation::ports::{ConversationLedger, PromptDelivery};
use poietica_conversation::turn::{Admission, AdmissionDecision};
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

fn admission(thread: &ThreadId, turn: &TurnId) -> Admission {
    Admission {
        thread: thread.clone(),
        turn: turn.clone(),
        prompt: "draft the release notes".to_owned(),
        model: "kimi-k2".to_owned(),
        attachments: Vec::new(),
        skills: Vec::new(),
        submitted_at_unix_millis: 1_700_000_000_000,
    }
}

#[test]
fn events_round_trip() {
    let (_directory, ledger) = ledger();
    let thread = ThreadId::new("thread-1".to_owned());
    let turn = TurnId::new("turn-1".to_owned());

    assert_eq!(
        ledger
            .admit(&PromptDelivery {
                admission: admission(&thread, &turn),
                session: "session-1".to_owned()
            })
            .expect("admit"),
        AdmissionDecision::Admitted
    );

    let envelopes = ledger
        .append(
            &thread,
            "session-1",
            &[ConversationEvent::RunFinished {
                turn: Some(turn.clone()),
                stop_reason: "completed".to_owned(),
            }],
        )
        .expect("append");

    assert_eq!(envelopes.len(), 1);
    assert_eq!(envelopes[0].seq, Seq::new(2));
    assert_eq!(envelopes[0].at, 1_700_000_000_000);
    assert_eq!(envelopes[0].session_id, "session-1");

    let events = ledger
        .events_after(&thread, Seq::NONE)
        .expect("read events");

    assert_eq!(events.len(), 2);
}
