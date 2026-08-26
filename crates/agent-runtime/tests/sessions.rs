//! What the session book promises: one entry per name, a slot only for
//! names it was told about, and nothing left behind when one is closed.
//!
//! Every answer is asserted rather than unwrapped, because a lint-clean
//! test may not reach for a panic to describe a failure.

use std::collections::HashMap;
use std::sync::mpsc;

use poietica_agent_runtime_native::{Recorder, SessionBook};

const FIRST: &str = "session_11111111-1111-4111-8111-111111111111";
const SECOND: &str = "session_22222222-2222-4222-8222-222222222222";

#[test]
fn mentioning_one_session_twice_opens_it_once() {
    let book = SessionBook::new();

    assert!(book.open(FIRST).is_ok());
    assert!(book.open(FIRST).is_ok());

    assert!(matches!(book.open_count(), Ok(1)));
}

#[test]
fn a_name_the_book_never_opened_has_no_slot() {
    let book = SessionBook::new();

    assert!(matches!(book.slot(FIRST), Ok(None)));
}

#[test]
fn closing_a_session_leaves_the_book_empty() {
    let book = SessionBook::new();

    assert!(book.open(FIRST).is_ok());
    assert!(book.close(FIRST).is_ok());

    assert!(matches!(book.open_count(), Ok(0)));
    assert!(matches!(book.slot(FIRST), Ok(None)));
}

#[test]
fn two_sessions_are_both_named() {
    let book = SessionBook::new();

    assert!(book.open(FIRST).is_ok());
    assert!(book.open(SECOND).is_ok());

    let names = book.ids().unwrap_or_default();

    assert!(matches!(book.open_count(), Ok(2)));
    assert!(names.iter().any(|name| name == FIRST));
    assert!(names.iter().any(|name| name == SECOND));
}

#[test]
fn many_sessions_record_concurrently_without_aliasing() {
    let book = SessionBook::new();
    let (delivered, arriving) = mpsc::channel();

    std::thread::scope(|scope| {
        for index in 0..64_u32 {
            let book = book.clone();
            let delivered = delivered.clone();

            scope.spawn(move || {
                let session = format!("session-{index}");
                assert!(book.open(&session).is_ok());
                let Ok(Some(slot)) = book.slot(&session) else {
                    return;
                };
                let recorded = session.clone();
                assert!(
                    slot.attach(|| {
                        Recorder::new(
                            recorded,
                            slot.seq(),
                            Box::new(move |event| {
                                let _sent = delivered.send(event);
                                true
                            }),
                        )
                    })
                    .is_ok()
                );
                assert!(slot.record(|recorder| {
                    recorder.record_prompt_admitted("adm", "prompt", Vec::new(), Vec::new());
                    recorder.record_run_finished("completed");
                }));
            });
        }
    });

    drop(delivered);
    let mut positions: HashMap<String, Vec<i64>> = HashMap::new();
    for event in arriving {
        positions
            .entry(event.session_id)
            .or_default()
            .push(event.seq);
    }

    assert_eq!(positions.len(), 64);
    assert!(positions.values().all(|seq| seq == &[1, 2]));
}
