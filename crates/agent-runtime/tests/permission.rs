#![allow(
    clippy::expect_used,
    clippy::unwrap_used,
    reason = "a test proves itself by panicking, so a failed step must fail the test"
)]
//! The permission round-trip over kap approvals, without an agent process.
//!
//! The desk is the only thing standing between an answer typed by a user and a
//! reply sent to the server, so the cases that matter here are the dishonest
//! ones: an answer nobody asked for, an option nobody offered, and a turn that
//! ended before anyone answered at all.

use futures::executor::block_on;
use poietica_agent_runtime_native::{
    Decision, PermissionDesk, kap_answers, kap_options, kap_response,
};
use serde_json::Value;
use serde_json::Value;
use serde_json::Value;

#[test]
fn an_answer_reaches_the_waiting_handler() {
    let desk = PermissionDesk::new();
    let waiting = desk.wait_kap("appr_1").expect("a fresh desk");

    desk.answer("appr_1", "approve")
        .expect("the answer to land");

    assert_eq!(
        block_on(waiting).expect("an answer"),
        Decision::Allow("approve".to_owned()),
        "the synthesized vocabulary decides what approving means"
    );
    assert_eq!(desk.waiting(), 0, "an answered request leaves the desk");
}

#[test]
fn an_option_that_was_never_offered_is_refused() {
    let desk = PermissionDesk::new();
    let waiting = desk.wait_kap("appr_2").expect("a fresh desk");

    assert!(
        desk.answer("appr_2", "sudo").is_err(),
        "the interface does not get to invent options"
    );
    assert_eq!(
        desk.waiting(),
        1,
        "a nonsensical answer must not destroy a request that is still waiting"
    );

    desk.answer("appr_2", "reject").expect("the real answer");

    assert_eq!(
        block_on(waiting).expect("an answer"),
        Decision::Reject("reject".to_owned())
    );
}

#[test]
fn an_answer_to_an_unknown_request_is_refused() {
    let desk = PermissionDesk::new();

    assert!(desk.answer("appr_404", "approve").is_err());
}

#[test]
fn a_turn_that_ends_first_cancels_the_wait() {
    let desk = PermissionDesk::new();
    let waiting = desk.wait_kap("appr_3").expect("a fresh desk");

    desk.clear();

    assert!(
        block_on(waiting).is_err(),
        "the waiter observes the abandonment and posts nothing"
    );
    assert_eq!(desk.waiting(), 0);
}

#[test]
fn the_offered_options_and_the_accepted_answers_are_one_vocabulary() {
    let offered = kap_options();
    let accepted = kap_answers();

    let options = offered.as_array().expect("the options are an array");

    assert_eq!(options.len(), 3);

    for option in options {
        let id = option
            .get("optionId")
            .and_then(Value::as_str)
            .expect("every option has an id");

        assert!(
            accepted.contains_key(id),
            "an option nobody may pick must not be shown: {id}"
        );
    }
}

#[test]
fn a_decision_speaks_kap_on_the_wire() {
    // approvalResponseSchema：decision ∈ approved / rejected / cancelled，
    // scope 只在「这条会话上记住」时是 session。
    assert_eq!(
        kap_response(&Decision::Allow("approve".to_owned())),
        ("approved", None)
    );
    assert_eq!(
        kap_response(&Decision::Allow("approve_session".to_owned())),
        ("approved", Some("session"))
    );
    assert_eq!(
        kap_response(&Decision::Reject("reject".to_owned())),
        ("rejected", None)
    );
    assert_eq!(kap_response(&Decision::Cancel), ("cancelled", None));
}
