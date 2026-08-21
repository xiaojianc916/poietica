#![allow(
    clippy::expect_used,
    clippy::unwrap_used,
    reason = "a test proves itself by panicking, so a failed step must fail the test"
)]
//! The permission round-trip over kap approvals, without an agent process.
//!
//! 桌子是「人点的那一下」与「发给 server 的那一帧」之间唯一的东西，所以这里守
//! 的是不老实的几种：没人问过的请求、结束在前的轮次，以及答复本身在线上说的话。

use futures::executor::block_on;
use poietica_agent_runtime_native::{Decision, PermissionDesk, Scope};

#[test]
fn an_answer_reaches_the_waiting_handler() {
    let desk = PermissionDesk::new();
    let waiting = desk.wait_kap("appr_1").expect("a fresh desk");

    desk.answer(
        "appr_1",
        Decision::Approved {
            scope: Some(Scope::Session),
        },
    )
    .expect("the answer to land");

    assert_eq!(
        block_on(waiting).expect("an answer"),
        Decision::Approved {
            scope: Some(Scope::Session)
        },
        "作用域随答复一起交到等待的那一侧"
    );
    assert_eq!(desk.waiting(), 0, "an answered request leaves the desk");
}

#[test]
fn an_answer_to_an_unknown_request_is_refused() {
    let desk = PermissionDesk::new();

    assert!(desk.answer("appr_404", Decision::Rejected).is_err());
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
fn a_decision_speaks_kap_on_the_wire() {
    // approvalResponseSchema：decision ∈ approved / rejected / cancelled，
    // scope 只在「这条会话上记住」时是 session。
    assert_eq!(Decision::Approved { scope: None }.on_wire(), "approved");
    assert!(Decision::Approved { scope: None }.scope().is_none());
    assert_eq!(
        Decision::Approved {
            scope: Some(Scope::Session)
        }
        .scope()
        .map(Scope::on_wire),
        Some("session")
    );
    assert_eq!(Decision::Rejected.on_wire(), "rejected");
    assert_eq!(Decision::Cancelled.on_wire(), "cancelled");
    assert!(Decision::Cancelled.scope().is_none());
}
