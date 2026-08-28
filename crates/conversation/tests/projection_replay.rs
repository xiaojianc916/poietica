use poietica_conversation::event::{ConversationEvent, EventEnvelope};
use poietica_conversation::identity::{Seq, ThreadId, TurnId};
use poietica_conversation::projection::{ThreadView, project};
use poietica_conversation::turn::{TurnCompletion, TurnState};

fn envelope(thread: &ThreadId, seq: u64, event: ConversationEvent) -> EventEnvelope {
    EventEnvelope {
        thread: thread.clone(),
        seq: Seq::new(seq),
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
            ConversationEvent::AssistantText {
                turn: turn.clone(),
                text: "he".to_owned(),
            },
        ),
        envelope(
            &thread,
            3,
            ConversationEvent::AssistantText {
                turn: turn.clone(),
                text: "llo".to_owned(),
            },
        ),
        envelope(
            &thread,
            4,
            ConversationEvent::TurnFinished {
                turn: turn.clone(),
                completion: TurnCompletion::Completed,
            },
        ),
    ];

    let replayed = project(&thread, &events);
    let mut live = ThreadView::empty(thread.clone());

    for event in &events {
        live.apply(event);
    }

    assert_eq!(replayed, live);
    assert_eq!(replayed.last_seq, Seq::new(4));

    let view = replayed.turns.get(&turn).unwrap();

    assert_eq!(view.text, "hello");
    assert_eq!(
        view.state,
        TurnState::Finished {
            completion: TurnCompletion::Completed
        }
    );
}

#[test]
fn unsupported_events_are_counted_not_dropped() {
    let thread = ThreadId::new("thread-2".to_owned());
    let events = vec![envelope(
        &thread,
        1,
        ConversationEvent::UnsupportedExternalEvent {
            raw_kind: "futureThing".to_owned(),
        },
    )];

    assert_eq!(project(&thread, &events).unsupported_events, 1);
}
