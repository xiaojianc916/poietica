#![allow(
    clippy::expect_used,
    clippy::unwrap_used,
    reason = "a test proves itself by panicking, so a failed step must fail the test"
)]
//! Recording and frame-shape behaviour, without an agent process.
//!
//! kap 的载荷在这里按线上形状手写（protocol/events.ts 与
//! protocol/approval.ts；快照钉在 contracts/kap）。帧的定义只有
//! src/frame.rs 一处，这些断言把它钉在界面读的那一份上。
//!
//! 断言只看帧。recorder 不写任何存储 —— 一段对话的持有者是 agent，所以这里
//! 没有第二份东西可以对。

mod frame_sink;

use poietica_kap_client::{ApprovalResponse, Decision, Recorder, Scope, kap_event};
use serde_json::{Value, json};

use frame_sink::{SESSION, recording, text_of};

fn notify(recorder: &mut Recorder, payload: Value) {
    recorder.record_frame(kap_event(payload));
}

fn tool_call_started() -> Value {
    json!({
        "type": "tool.call.started",
        "turnId": 1,
        "toolCallId": "call_001",
        "name": "Read config.toml",
        "args": { "path": "config.toml" }
    })
}

fn approval() -> Value {
    json!({
        "approval_id": "appr_001",
        "session_id": SESSION,
        "tool_call_id": "call_100",
        "tool_name": "Bash",
        "action": "run_command",
        "tool_input_display": { "command": "cargo test" },
        "created_at": "2026-08-18T00:00:00.000Z",
        "expires_at": "2026-08-19T00:00:00.000Z"
    })
}

#[test]
fn every_frame_carries_the_fields_the_interface_validates() {
    let (mut recorder, delivered) = recording();

    recorder.record_prompt_admitted("adm", "read config.toml", Vec::new(), Vec::new());
    notify(&mut recorder, tool_call_started());
    recorder.record_run_finished("completed");

    let frames = delivered.wire();

    assert_eq!(frames.len(), 3);

    for (position, frame) in frames.iter().enumerate() {
        assert!(frame.get("kind").is_some_and(Value::is_string), "kind");
        assert_eq!(
            text_of(frame, "sessionId"),
            SESSION,
            "每一帧都带会话号，六种无一例外"
        );
        assert!(frame.get("seq").is_some_and(Value::is_number), "seq");
        assert!(frame.get("at").is_some_and(Value::is_number), "at");
        assert_eq!(
            frame.get("seq").and_then(Value::as_i64),
            i64::try_from(position + 1).ok(),
            "sequence numbers are dense and ordered"
        );
    }

    let started = frames.first().expect("the first frame");
    assert_eq!(text_of(started, "kind"), "prompt_admitted");
    assert_eq!(text_of(started, "prompt"), "read config.toml");

    let event = frames.get(1).expect("the event frame");
    assert_eq!(text_of(event, "kind"), "kap_event");
    let payload = event.get("payload").expect("the kap payload");
    assert_eq!(text_of(payload, "type"), "tool.call.started");
    assert_eq!(text_of(payload, "toolCallId"), "call_001");

    let finished = frames.last().expect("the last frame");
    assert_eq!(text_of(finished, "kind"), "run_finished");
    assert_eq!(text_of(finished, "stopReason"), "completed");
}

#[test]
fn a_permission_request_and_its_answer_are_two_frames() {
    let (mut recorder, delivered) = recording();

    let request_id =
        recorder.record_permission_requested_kap("appr_001", "call_100", "Bash", &approval());

    // 请求号就是 kap 签发的审批号：答复从界面回来时，桌上认的也是它。
    assert_eq!(request_id, "appr_001");

    assert_eq!(recorder.outstanding_permissions().len(), 1);

    recorder.record_permission_resolved_kap(
        &request_id,
        ApprovalResponse {
            decision: Decision::Approved {
                scope: Some(Scope::Session),
            },
            selected_label: None,
            feedback: None,
        },
    );

    let frames = delivered.wire();

    assert_eq!(frames.len(), 2);

    let requested = frames.first().expect("the request frame");
    assert_eq!(text_of(requested, "kind"), "permission_requested");
    assert_eq!(text_of(requested, "requestId"), "appr_001");
    assert_eq!(text_of(requested, "toolCallId"), "call_100");
    assert_eq!(text_of(requested, "title"), "Bash");

    // kap 的审批请求不带选项，帧也不合成一张：能答什么由 Decision 穷举。
    assert!(
        requested.get("options").is_none(),
        "客户端不再发明一张选项表"
    );

    // 帧里的 tool_call 是归一化后的三格，不是审批项原文；null 成员不出线。
    let tool_call = requested.get("toolCall").expect("the approval item");
    assert_eq!(text_of(tool_call, "toolCallId"), "call_100");
    assert_eq!(text_of(tool_call, "title"), "Bash");

    let raw_input = tool_call.get("rawInput").expect("the display hint");
    assert_eq!(text_of(raw_input, "command"), "cargo test");

    let resolved = frames.get(1).expect("the answer frame");
    assert_eq!(text_of(resolved, "kind"), "permission_resolved");
    assert_eq!(text_of(resolved, "requestId"), "appr_001");
    assert_eq!(text_of(resolved, "decision"), "approved");
    assert_eq!(text_of(resolved, "scope"), "session");

    assert!(recorder.outstanding_permissions().is_empty());
}

#[test]
fn a_request_left_open_at_the_end_of_a_turn_is_settled() {
    let (mut recorder, delivered) = recording();

    let _request_id =
        recorder.record_permission_requested_kap("appr_002", "call_101", "Write", &approval());

    recorder.record_pending_cancelled();

    assert!(recorder.outstanding_permissions().is_empty());

    let resolved = delivered.wire();
    let last = resolved.last().expect("the answer frame");

    assert_eq!(text_of(last, "decision"), "cancelled");
    assert!(last.get("scope").is_none(), "只此一次的答复不带 scope");
}

#[test]
fn an_approval_without_a_tool_name_falls_back_to_its_action() {
    let (mut recorder, delivered) = recording();

    let request_id =
        recorder.record_permission_requested_kap("appr_003", "call_102", "", &approval());

    let frames = delivered.wire();
    let requested = frames.first().expect("the request frame");

    assert_eq!(text_of(requested, "requestId"), request_id);
    assert_eq!(
        text_of(requested, "title"),
        "run_command",
        "名不在才轮到动作，都不在就报调用号"
    );
}
