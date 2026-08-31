#![allow(
    clippy::get_unwrap,
    clippy::unwrap_used,
    clippy::indexing_slicing,
    reason = "a test proves itself by panicking, so a missing turn must fail the test"
)]

use poietica_conversation::event::{ConversationEvent, EventEnvelope};
use poietica_conversation::identity::{Seq, ThreadId, TurnId};
use poietica_conversation::projection::{OpenInteraction, ThreadView, project};
use poietica_conversation::turn::{TurnCompletion, TurnState};

fn envelope(thread: &ThreadId, seq: u64, event: ConversationEvent) -> EventEnvelope {
    EventEnvelope {
        thread: thread.clone(),
        seq: Seq::new(seq),
        at: 1_700_000_000_000,
        session_id: "session-1".to_owned(),
        event,
    }
}

#[test]
fn cold_replay_matches_incremental_apply() {
    let thread = ThreadId::new("thread-1".to_owned());
    let turn = TurnId::new("turn-1".to_owned());
    let events = vec![
        envelope(
            &thread,
            1,
            ConversationEvent::TurnAdmitted { turn: turn.clone() },
        ),
        envelope(
            &thread,
            2,
            ConversationEvent::RunFinished {
                turn: Some(turn.clone()),
                stop_reason: "completed".to_owned(),
            },
        ),
    ];

    let replayed = project(&thread, &events);
    let mut live = ThreadView::empty(thread.clone());

    for event in &events {
        live.apply(event);
    }

    assert_eq!(replayed, live);
    assert_eq!(replayed.last_seq, Seq::new(2));

    let view = replayed.turns.get(&turn).unwrap();

    assert_eq!(
        view.state,
        TurnState::Finished {
            completion: TurnCompletion::Completed
        }
    );
}

#[test]
fn admission_names_the_turn_on_the_screen_stream() {
    let thread = ThreadId::new("thread-3".to_owned());
    let turn = TurnId::new("turn-3".to_owned());
    let events = vec![envelope(
        &thread,
        1,
        ConversationEvent::PromptAdmitted {
            admission_id: turn.clone(),
            prompt: Some("draft the release notes".to_owned()),
            images: None,
            skills: None,
        },
    )];

    let view = project(&thread, &events);

    assert_eq!(view.turn_order, vec![turn]);
}

#[test]
fn interactions_open_and_close_by_their_agent_issued_id() {
    let thread = ThreadId::new("thread-4".to_owned());
    let events = vec![
        envelope(
            &thread,
            1,
            ConversationEvent::PermissionRequested {
                request_id: "approval-1".to_owned(),
                tool_call_id: Some("call-1".to_owned()),
                title: "Write a file".to_owned(),
                tool_call: serde_json::json!({ "toolCallId": "call-1" }),
            },
        ),
        envelope(
            &thread,
            2,
            ConversationEvent::PermissionResolved {
                request_id: "approval-1".to_owned(),
                decision: "approved".to_owned(),
                scope: None,
                selected_label: None,
                feedback: None,
            },
        ),
    ];

    let mid = project(&thread, &events[..1]);
    assert_eq!(
        mid.open_interactions.get("approval-1"),
        Some(&OpenInteraction::Permission)
    );

    let done = project(&thread, &events);
    assert!(done.open_interactions.is_empty());
}

#[test]
fn unparsed_events_are_counted_not_dropped() {
    let thread = ThreadId::new("thread-2".to_owned());
    let events = vec![
        envelope(
            &thread,
            1,
            ConversationEvent::UnsupportedExternalEvent {
                raw_kind: "futureThing".to_owned(),
            },
        ),
        envelope(
            &thread,
            2,
            ConversationEvent::KapEvent {
                payload: serde_json::json!({ "type": "assistant.delta" }),
            },
        ),
    ];

    assert_eq!(project(&thread, &events).unparsed_events, 2);
}
