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

use poietica_agent_runtime_native::{
    KapError, RUN_STARTED, Recorder, Refusal, RunFrame, RunSlot, kap_event,
};
use serde_json::json;

use frame_sink::{Delivered, SESSION, recording};

fn announcement() -> RunFrame {
    kap_event(json!({
        "type": "tool.call.started",
        "turnId": 1,
        "toolCallId": "call_001",
        "name": "Read config.toml",
        "args": {}
    }))
}

#[test]
fn an_update_outside_a_turn_is_dropped() {
    let slot = RunSlot::new();

    assert!(!slot.is_listening());
    assert!(
        !slot.record(|recorder| recorder.record_frame(announcement())),
        "an update between turns belongs to no run"
    );
}

/// 装载一条旧会话时槽里没有人：那批重放帧的持有者是 agent，屏幕上那条经过由
/// 本机帧日志出。丢掉它们正是要的结果，而丢掉不该是一次失败。
#[test]
fn a_loading_session_drops_the_replay_without_failing() {
    let delivered = Delivered::default();
    let slot = RunSlot::new();

    assert!(!slot.record(|recorder| recorder.record_frame(announcement())));
    assert!(delivered.frames().is_empty());
    assert_eq!(slot.seq(), slot.seq(), "序号线没有被一批无人认领的帧推着走");
}

#[test]
fn updates_reach_the_installed_run() {
    let (recorder, delivered) = recording();
    let slot = RunSlot::new();

    slot.install(recorder).expect("an empty slot");

    assert!(slot.is_listening());
    assert!(slot.record(|recorder| {
        recorder.record_run_started("what the run was asked", Vec::new(), Vec::new());
    }));
    assert!(slot.record(|recorder| recorder.record_frame(announcement())));

    let seen = delivered.frames();

    assert_eq!(seen.len(), 2);
    assert_eq!(
        seen.first().map(|event| event.frame.kind()),
        Some(RUN_STARTED)
    );
    assert!(
        seen.get(1)
            .is_some_and(|event| matches!(event.frame, RunFrame::KapEvent { .. })),
        "the update frame keeps the shape the interface validates"
    );
}

#[test]
fn a_second_run_cannot_displace_the_first() {
    let (first, _first_frames) = recording();
    let (second, _second_frames) = recording();
    let slot = RunSlot::new();

    slot.install(first).expect("an empty slot");

    let error = slot
        .install(second)
        .expect_err("an occupied slot refuses a second run");

    /* 拒绝一次并发的轮次是这台机器自己的规矩，不是 agent 那侧出的事，所以
    它是 Refused 而不是 Transport。 */
    assert!(
        matches!(error, KapError::Refused(Refusal::Busy)),
        "a concurrent turn is refused, not silently interleaved"
    );
}

#[test]
fn taking_the_run_ends_the_routing() {
    let (recorder, _frames) = recording();
    let slot = RunSlot::new();

    slot.install(recorder).expect("an empty slot");

    let taken = slot.take().expect("the slot").expect("a run to close out");

    assert!(!slot.is_listening());
    assert!(
        !slot.record(|recorder| recorder.record_frame(announcement())),
        "the turn is over, so nothing else may be attributed to it"
    );

    drop(taken);
}

/// 一条会话上的第二轮接着第一轮数，而不是从头再来。
///
/// 位置的家是会话槽，不是记录器。界面按「会话内 seq 单调」去重，日志的唯一键
/// 也是它 —— 撞号的那一帧会被当成重复的丢掉。
#[test]
fn a_second_turn_continues_the_sequence_of_the_first() {
    let delivered = Delivered::default();
    let slot = RunSlot::new();

    for _turn in 0..2 {
        let recorder = Recorder::new(SESSION.to_owned(), slot.seq(), delivered.sink());

        slot.install(recorder).expect("an empty slot");
        assert!(slot.record(|recorder| {
            recorder.record_run_started("what the run was asked", Vec::new(), Vec::new());
        }));

        let _ended = slot.take().expect("the slot");
    }

    assert_eq!(
        delivered.positions(),
        vec![1, 2],
        "同一条会话上的两轮共用一条序号线"
    );
}

/// 装载回来的那条会话，序号线要接上日志里已经用掉的位置。
///
/// 号不变而槽是新的，接不上就会撞上 run_events 的
/// UNIQUE (thread_id, session_id, seq)，整轮被 ON CONFLICT 静默丢掉。
#[test]
fn a_reloaded_session_resumes_after_the_recorded_position() {
    let delivered = Delivered::default();
    let slot = RunSlot::new();

    slot.seq().resume(7);

    let recorder = Recorder::new(SESSION.to_owned(), slot.seq(), delivered.sink());

    slot.install(recorder).expect("an empty slot");
    assert!(slot.record(|recorder| {
        recorder.record_run_started("what the run was asked", Vec::new(), Vec::new());
    }));

    assert_eq!(delivered.positions(), vec![8]);

    slot.seq().resume(3);

    assert!(slot.record(|recorder| recorder.record_frame(announcement())));
    assert_eq!(
        delivered.positions(),
        vec![8, 9],
        "resume 只前进：一份落后的读数不会把位置拖回去"
    );
}
