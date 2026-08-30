#![allow(
    clippy::expect_used,
    clippy::indexing_slicing,
    reason = "a test proves itself by panicking, so a failing ledger step must fail the test"
)]

use poietica_conversation::event::ConversationEvent;
use poietica_conversation::identity::{Seq, ThreadId, TurnId};
use poietica_conversation::ports::ConversationLedger;
use poietica_conversation::projection::project;
use poietica_conversation::turn::{Admission, AdmissionDecision, TurnCompletion, TurnState};
use poietica_ledger::SqliteLedger;
use poietica_ledger::connection::open_in_memory;
use poietica_ledger::projection::rebuild;
use poietica_time::test_clock::TestClock;

fn ledger() -> SqliteLedger<TestClock> {
    let ledger = SqliteLedger::new(
        open_in_memory().expect("in-memory ledger opens"),
        TestClock::at_unix_millis(1_700_000_000_000),
    );

    ledger.migrate().expect("migrations apply");

    ledger
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
fn events_round_trip_and_projection_rebuilds() {
    let ledger = ledger();
    let thread = ThreadId::new("thread-1".to_owned());
    let turn = TurnId::new("turn-1".to_owned());

    assert_eq!(
        ledger.admit(&admission(&thread, &turn)).expect("admit"),
        AdmissionDecision::Admitted
    );

    let envelopes = ledger
        .append(
            &thread,
            "session-1",
            &[
                ConversationEvent::TurnAdmitted { turn: turn.clone() },
                ConversationEvent::RunFinished {
                    turn: Some(turn.clone()),
                    stop_reason: "completed".to_owned(),
                },
            ],
        )
        .expect("append");

    assert_eq!(envelopes.len(), 2);
    assert_eq!(envelopes[0].seq, Seq::new(1));
    assert_eq!(envelopes[1].seq, Seq::new(2));
    assert_eq!(envelopes[0].at, 1_700_000_000_000);
    assert_eq!(envelopes[0].session_id, "session-1");

    let events = ledger
        .events_after(&thread, Seq::NONE)
        .expect("read events");

    assert_eq!(events.len(), 2);

    let view = project(&thread, &events);
    let rebuilt = rebuild(
        &ledger.guard().expect("the ledger lock"),
        ledger.clock(),
        &thread,
    )
    .expect("rebuild projection");

    assert_eq!(view, rebuilt);
    assert_eq!(
        rebuilt.turns.get(&turn).map(|turn| turn.state.clone()),
        Some(TurnState::Finished {
            completion: TurnCompletion::Completed
        })
    );
}
