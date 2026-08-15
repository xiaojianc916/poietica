#![allow(
    clippy::expect_used,
    clippy::unwrap_used,
    reason = "a test proves itself by panicking, so a failed step must fail the test"
)]
//! Recording, frame shape and projection behaviour, without an agent process.
//!
//! The updates here are built with the SDK's own constructors, so the shapes
//! under test are the shapes the protocol actually delivers. The frames are
//! defined once, by `RunFrame` in `src/frame.rs`; these assertions are what
//! pins that definition to the shape the interface reads, so a renamed field
//! fails here rather than emptying a conversation on screen.
//!
//! 断言只看帧。recorder 不写任何存储 —— 一段对话的持有者是 agent，历史由
//! session/load 交回来，所以这里没有第二份东西可以对。

mod frame_sink;

use agent_client_protocol::schema::v1::{
    PermissionOption, PermissionOptionKind, RequestPermissionRequest, SessionNotification,
    SessionUpdate, ToolCall, ToolCallStatus, ToolCallUpdate, ToolCallUpdateFields, ToolKind,
};
use poietica_agent_runtime_native::{Decision, Recorder, acp_update};
use serde_json::Value;

use frame_sink::{SESSION, recording, text_of};

fn notify(recorder: &mut Recorder, update: SessionUpdate) {
    recorder.note_tool_titles(&update);
    let framed =
        acp_update(&SessionNotification::new(SESSION, update)).expect("the update encodes");

    recorder.record_frame(framed);
}

#[test]
fn every_frame_carries_the_fields_the_interface_validates() {
    let (mut recorder, delivered) = recording();

    recorder.record_run_started("read config.toml", Vec::new());
    notify(
        &mut recorder,
        SessionUpdate::ToolCall(
            ToolCall::new("call_001", "Read config.toml")
                .kind(ToolKind::Read)
                .status(ToolCallStatus::Pending),
        ),
    );
    recorder.record_run_finished("end_turn");

    assert!(recorder.take_failure().is_none());

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
    assert_eq!(text_of(started, "kind"), "run_started");
    assert_eq!(
        text_of(started, "prompt"),
        "read config.toml",
        "the interface reads the question from the log, not from an echo"
    );

    let update = frames.get(1).expect("the update frame");
    assert_eq!(text_of(update, "kind"), "acp_update");
    let notification = update.get("notification").expect("a notification");
    assert_eq!(text_of(notification, "sessionId"), SESSION);
    let inner = notification.get("update").expect("an update");
    assert_eq!(text_of(inner, "sessionUpdate"), "tool_call");
    assert_eq!(text_of(inner, "toolCallId"), "call_001");
    assert_eq!(text_of(inner, "status"), "pending");
    assert_eq!(text_of(inner, "kind"), "read");

    let finished = frames.last().expect("the last frame");
    assert_eq!(text_of(finished, "kind"), "run_finished");
    assert_eq!(
        text_of(finished, "stopReason"),
        "end_turn",
        "the interface only accepts the protocol's own stop reasons"
    );
}

#[test]
fn an_optional_protocol_field_is_absent_rather_than_null() {
    let (mut recorder, delivered) = recording();

    notify(
        &mut recorder,
        SessionUpdate::ToolCall(
            ToolCall::new("call_002", "Editing").status(ToolCallStatus::InProgress),
        ),
    );
    notify(
        &mut recorder,
        SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
            "call_002",
            ToolCallUpdateFields::new().title("Editing main.rs"),
        )),
    );

    assert!(recorder.take_failure().is_none());

    let frames = delivered.wire();
    let inner = frames
        .get(1)
        .and_then(|frame| frame.get("notification"))
        .and_then(|notification| notification.get("update"))
        .expect("an update");

    assert_eq!(text_of(inner, "title"), "Editing main.rs");
    assert!(
        inner.get("status").is_none(),
        "an optional field the agent did not set is absent, not null"
    );
}

#[test]
fn an_update_for_an_unannounced_call_is_projected_as_an_upsert() {
    let (mut recorder, delivered) = recording();

    notify(
        &mut recorder,
        SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
            "call_404",
            ToolCallUpdateFields::new()
                .title("Reading main.rs")
                .status(ToolCallStatus::Completed),
        )),
    );

    /* 更新先于宣告到达是协议允许的：子代理在自己的会话号下发起的调用、
    session/load 重播回来的历史、以及 agent 把首帧合并进更新，都会这样。
    界面侧 upsertToolCall 对未知 id 建占位卡，原生侧必须是同一种语义。 */
    assert!(recorder.take_failure().is_none());

    let frames = delivered.wire();

    assert_eq!(frames.len(), 1, "更新照常成帧交出去，不是被吞掉");

    let inner = frames
        .first()
        .and_then(|frame| frame.get("notification"))
        .and_then(|notification| notification.get("update"))
        .expect("an update");

    assert_eq!(text_of(inner, "sessionUpdate"), "tool_call_update");
    assert_eq!(text_of(inner, "toolCallId"), "call_404");
    assert_eq!(text_of(inner, "status"), "completed");

    // 「没有失败」是个弱断言 —— 把 project 整个删掉它也能过。占位真的建起
    // 来了，要由一个不带标题的权限请求来证明：界面要求有标题，而这个标题
    // 只能来自那次未宣告的更新。
    let request = RequestPermissionRequest::new(
        SESSION,
        ToolCallUpdate::new("call_404", ToolCallUpdateFields::new()),
        vec![PermissionOption::new(
            "reject",
            "Reject",
            PermissionOptionKind::RejectOnce,
        )],
    );

    let request_id = recorder.record_permission_requested(&request);

    assert!(recorder.take_failure().is_none());

    let frames = delivered.wire();
    let requested = frames.get(1).expect("the request frame");

    assert_eq!(text_of(requested, "kind"), "permission_requested");
    assert_eq!(text_of(requested, "requestId"), request_id);
    assert_eq!(
        text_of(requested, "title"),
        "Reading main.rs",
        "占位卡上的名字来自那次未宣告的更新，不是回头去查日志"
    );
}

#[test]
fn a_permission_request_is_refused_and_recorded() {
    let (mut recorder, delivered) = recording();

    let request = RequestPermissionRequest::new(
        SESSION,
        ToolCallUpdate::new(
            "call_005",
            ToolCallUpdateFields::new().title("Run cargo test"),
        ),
        vec![
            PermissionOption::new("allow", "Allow", PermissionOptionKind::AllowOnce),
            PermissionOption::new("reject", "Reject", PermissionOptionKind::RejectOnce),
        ],
    );

    let decision = poietica_agent_runtime_native::decide(&request);

    assert!(
        matches!(&decision, Decision::Reject(option_id) if option_id.to_string() == "reject"),
        "an unattended client refuses, using the agent's own option"
    );

    /* 按生产路径的顺序来：driver.rs 先记下问题，再记下答复，中间隔着一次
    等待。把两步并成一步的便利方法证明不了生产行为。 */
    let request_id = recorder.record_permission_requested(&request);
    recorder.record_permission_resolved(&request_id, &decision);

    assert!(recorder.take_failure().is_none());

    let frames = delivered.wire();
    let requested = frames.first().expect("the request frame");

    assert_eq!(text_of(requested, "kind"), "permission_requested");
    assert_eq!(text_of(requested, "requestId"), request_id);
    assert_eq!(text_of(requested, "toolCallId"), "call_005");
    assert_eq!(
        text_of(requested, "title"),
        "Run cargo test",
        "the interface requires a title even though the protocol does not"
    );

    let option = requested
        .get("options")
        .and_then(|options| options.get(0))
        .expect("the first option");

    assert_eq!(text_of(option, "optionId"), "allow");
    assert_eq!(text_of(option, "kind"), "allow_once");
    assert_eq!(text_of(option, "name"), "Allow");

    let resolved = frames.get(1).expect("the answer frame");

    assert_eq!(text_of(resolved, "kind"), "permission_resolved");
    assert_eq!(text_of(resolved, "requestId"), request_id);
    assert_eq!(text_of(resolved, "optionId"), "reject");
    assert_eq!(
        text_of(resolved, "outcome"),
        "selected",
        "refusing by choosing a refusal option is a selection, not a cancellation"
    );

    assert!(
        recorder.outstanding_permissions().is_empty(),
        "the request was answered as it was recorded"
    );
}

#[test]
fn an_announcement_carries_every_field_the_boundary_requires() {
    let (mut recorder, delivered) = recording();

    // Both defaults at once: pending is the default status, and this call is
    // announced without a kind. Serialisation omits them, and the interface
    // draws a card with no title and no icon if they stay omitted, so the
    // recorder puts them back from the SDK's own values.
    notify(
        &mut recorder,
        SessionUpdate::ToolCall(ToolCall::new("call_006", "Read config.toml")),
    );

    assert!(recorder.take_failure().is_none());

    let frames = delivered.wire();
    let inner = frames
        .first()
        .and_then(|frame| frame.get("notification"))
        .and_then(|notification| notification.get("update"))
        .expect("an update");

    assert_eq!(text_of(inner, "toolCallId"), "call_006");
    assert_eq!(text_of(inner, "title"), "Read config.toml");
    assert_eq!(
        text_of(inner, "status"),
        "pending",
        "a default status is still a status the interface demands"
    );
    assert!(
        !text_of(inner, "kind").is_empty(),
        "a default kind is still a kind the interface demands"
    );
}
