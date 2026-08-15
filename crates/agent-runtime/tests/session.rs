#![allow(
    clippy::expect_used,
    clippy::unwrap_used,
    reason = "a test proves itself by panicking, so a failed step must fail the test"
)]
//! The seam between a connection-lived handler and a run-lived recorder.
//!
//! The driver itself needs an agent process, so what is covered here is the
//! part that decides which run an update belongs to. Getting that wrong would
//! attribute frames to the previous turn, which no compiler would catch.

mod frame_sink;

use agent_client_protocol::schema::v1::{SessionNotification, SessionUpdate, ToolCall};
use poietica_agent_runtime_native::{
    ACP_UPDATE, AcpError, Frames, Listening, RUN_STARTED, Recorder, Refusal, RunFrame, RunSlot,
    acp_update,
};

use frame_sink::{Delivered, SESSION, recording};

fn announcement() -> RunFrame {
    acp_update(&SessionNotification::new(
        SESSION,
        SessionUpdate::ToolCall(ToolCall::new("call_001", "Read config.toml")),
    ))
    .expect("the update encodes")
}

#[test]
fn an_update_outside_a_turn_is_dropped() {
    let slot = RunSlot::new();

    assert!(!slot.is_listening());
    assert!(
        !slot.record(|listening| listening.frame(announcement())),
        "an update between turns belongs to no run"
    );
}

#[test]
fn updates_reach_the_installed_run() {
    let (recorder, delivered) = recording();
    let slot = RunSlot::new();

    slot.install(Listening::Turn(recorder))
        .expect("an empty slot");

    assert!(slot.is_listening());
    assert!(slot.record(|listening| {
        if let Some(recorder) = listening.turn_mut() {
            recorder.record_run_started("what the run was asked", Vec::new());
        }
    }));
    assert!(slot.record(|listening| listening.frame(announcement())));

    let seen = delivered.frames();

    assert_eq!(seen.len(), 2);
    assert_eq!(
        seen.first().map(|event| event.frame.kind()),
        Some(RUN_STARTED)
    );
    assert!(
        seen.get(1)
            .is_some_and(|event| matches!(event.frame, RunFrame::AcpUpdate { .. })),
        "the update frame keeps the shape the interface validates"
    );
}

#[test]
fn a_second_run_cannot_displace_the_first() {
    let (first, _first_frames) = recording();
    let (second, _second_frames) = recording();
    let slot = RunSlot::new();

    slot.install(Listening::Turn(first)).expect("an empty slot");

    let error = slot
        .install(Listening::Turn(second))
        .expect_err("an occupied slot refuses a second run");

    /* 拒绝一次并发的轮次是这台机器自己的规矩，不是 agent 那侧出的事，所以
    它是 Refused 而不是 Protocol。 */
    assert!(
        matches!(error, AcpError::Refused(Refusal::Busy)),
        "a concurrent turn is refused, not silently interleaved"
    );
}

/// 装载一条旧会话时，槽里站的是重播听众：帧照样成形、照样投递，只是没有
/// 日志可写 —— 这一份历史的持有者是 agent。
///
/// 断言的 kind 与上面那个实时测试是同一个，这才是重点：两边不是碰巧长得像，
/// 是同一个 `acp_update` 做出来的同一种帧。
#[test]
fn a_loading_session_forwards_its_replay_without_a_log() {
    let delivered = Delivered::default();
    let slot = RunSlot::new();

    slot.install(Listening::Replay(Frames::new(
        SESSION.to_owned(),
        slot.seq(),
        delivered.sink(),
    )))
    .expect("an empty slot");

    assert!(
        slot.record(|listening| listening.frame(announcement())),
        "装载期间这条会话上有人在听"
    );

    let held = delivered.frames();

    assert_eq!(held.len(), 1);
    assert_eq!(
        held.first().map(|event| event.frame.kind()),
        Some(ACP_UPDATE)
    );
    assert!(
        held.first()
            .is_some_and(|event| matches!(event.frame, RunFrame::AcpUpdate { .. })),
        "重播帧的形状与实时帧相同"
    );
}

#[test]
fn taking_the_run_ends_the_routing() {
    let (recorder, _frames) = recording();
    let slot = RunSlot::new();

    slot.install(Listening::Turn(recorder))
        .expect("an empty slot");

    let taken = slot.take().expect("the slot").expect("a run to close out");

    assert!(!slot.is_listening());
    assert!(
        !slot.record(|listening| listening.frame(announcement())),
        "the turn is over, so nothing else may be attributed to it"
    );

    drop(taken);
}

/// 一条会话上的第二轮接着第一轮数，而不是从头再来。
///
/// 位置的家是会话槽，不是记录器。界面按「会话内 seq 单调」去重，撞号的那一帧
/// 会被当成重复的丢掉 —— 这是把计数从轮次搬到会话时唯一会掉进去的坑。
#[test]
fn a_second_turn_continues_the_sequence_of_the_first() {
    let delivered = Delivered::default();
    let slot = RunSlot::new();

    for _turn in 0..2 {
        let recorder = Recorder::new(SESSION.to_owned(), slot.seq(), delivered.sink());

        slot.install(Listening::Turn(recorder))
            .expect("an empty slot");
        assert!(slot.record(|listening| {
            if let Some(recorder) = listening.turn_mut() {
                recorder.record_run_started("what the run was asked", Vec::new());
            }
        }));

        let _ended = slot.take().expect("the slot");
    }

    assert_eq!(
        delivered.positions(),
        vec![1, 2],
        "同一条会话上的两轮共用一条序号线"
    );
}
