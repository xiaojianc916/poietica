//! DeepSeek harness SDK 线协议的定形层：换行分隔的 JSON-RPC 2.0。
//!
//! 形状判据逐字来自官方 @deepseek-ai/dsh-sdk-protocol（deepseek-harness 仓库
//! packages/sdk/protocol/src/types.ts 与 transport.ts，0.1.0-rc.5）：带 id 与
//! method 的帧是请求，只带 id 是应答，只带 method 是通知；坏行就地丢弃。
//!
//! Rust 侧没有官方 SDK 可 re-export（见 docs/adr 的换轨记录），所以手写面收到
//! 最小：三个请求与四个通知的信封。会话事件与内容块保持 Value —— 会话词汇归
//! 投影层解读，与 frame.rs 对 SessionUpdate 的处置同构。这一层不做 I/O：进程
//! 管理与事件循环归 driver。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 官方服务端自报的线上稳定身份。
pub const SERVER_NAME: &str = "deepseek-harness-sdk-runtime";

/// 客户端可发的三个方法名。
pub const INITIALIZE: &str = "initialize";
pub const SESSION_PROMPT: &str = "session/prompt";
pub const SHUTDOWN: &str = "shutdown";

/// 进程级握手参数。cwd、provider 与 model 定在握手上，不在会话上 ——
/// 换 provider 或模型意味着换一个运行时进程。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub cwd: String,
    pub provider: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u64>,
}

/// 握手应答：服务端身份。名字应等于 SERVER_NAME；版本无兼容承诺，只作诊断。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    pub server_info: ServerInfo,
}

/// 线上自报的名字与版本。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ServerInfo {
    pub name: String,
    pub version: String,
}

/// 一轮提问。会话 id 由客户端命名：未知 id 惰性建出 agent+会话对。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPromptParams {
    pub session_id: String,
    /// 内容块按 dsh-llm 的 ContentBlock 词汇原样传递，这里不定形。
    pub content_blocks: Vec<Value>,
}

/// 入队回执。回执标记的是排队的用户消息，不是一轮的终点；终点看 session.status。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPromptResult {
    pub message_id: String,
}

/// session.event：一条会话日志事件。运行时里每条会话都报，不只 SDK 建的那些。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEventNotification {
    pub session_id: String,
    /// 完整会话日志信封（dsh-session 的 SessionEvent），词汇开放，保持原样。
    pub event: Value,
}

/// session.status：某条会话的整 agent 状态迁移。idle 是一轮结束的判据。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatusNotification {
    pub session_id: String,
    pub status: SessionStatus,
}

/// 整 agent 的两种状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Idle,
    Running,
}

/// subagent.started：运行时内开出了一条子会话。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentStartedNotification {
    pub parent_session_id: String,
    pub child_session_id: String,
}

/// subagent.finished：一次进程内子 agent 运行收尾（远程运行不报）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentFinishedNotification {
    pub provider: String,
    pub agent_id: String,
    pub parent_session_id: String,
    pub child_session_id: String,
    pub status: SdkRunStatus,
    /// SubagentStopReason：词汇归 dsh-subagent，保持原样。
    pub stop_reason: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_assistant_message: Option<Vec<Value>>,
}

/// 部署侧的两种结局。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SdkRunStatus {
    Ok,
    Error,
}

/// JSON-RPC 请求号。我们只发字符串号；数字号是规范允许的入站形态。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    Text(String),
    Number(i64),
}

/// 应答错误体，线上的 code 与 data 原样保留。
#[derive(Debug, Clone, PartialEq)]
pub struct ErrorBody {
    pub code: Option<i64>,
    pub message: String,
    pub data: Option<Value>,
}

/// 服务端来的一帧，按官方传输的判读规则分辨。
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    /// 对我们某次请求的应答。
    Response {
        id: RequestId,
        outcome: Result<Value, ErrorBody>,
    },
    /// 单向通知。
    Notification(Notification),
    /// 服务端请求。今天的官方服务端不发（server→client 是 dead capability）；
    /// 到达即以 -32601 作答，与官方传输对无处理器请求的行为一致。
    Request { id: RequestId, method: String },
}

/// 已定形的通知。词汇之外或形状对不上的进 Other，由 driver 记 trace，不静默丢。
#[derive(Debug, Clone, PartialEq)]
pub enum Notification {
    SessionEvent(SessionEventNotification),
    SessionStatus(SessionStatusNotification),
    SubagentStarted(SubagentStartedNotification),
    SubagentFinished(SubagentFinishedNotification),
    Other { method: String },
}

/// 编握手请求成一行（含行尾换行）。
pub fn initialize_line(id: &str, params: &InitializeParams) -> Result<String, serde_json::Error> {
    request_line(id, INITIALIZE, params)
}

/// 编一轮提问成一行。
pub fn prompt_line(id: &str, params: &SessionPromptParams) -> Result<String, serde_json::Error> {
    request_line(id, SESSION_PROMPT, params)
}

/// 编 shutdown 请求。官方服务端把 params 缺席与空表当同一件事（objectParams），
/// 这里发空表。
pub fn shutdown_line(id: &str) -> String {
    let frame = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": SHUTDOWN,
        "params": {},
    });

    format!("{frame}\n")
}

/// 对不认识的服务端请求作答：-32601，消息格式与官方传输逐字相同。
pub fn method_not_found_line(id: &RequestId, method: &str) -> String {
    let frame = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": -32601, "message": format!("method not found: {method}") },
    });

    format!("{frame}\n")
}

/// 判读服务端的一行。坏行、空行与形状之外的帧交回 None —— 官方传输对坏行的
/// 处置就是丢弃，这里不另立规矩。
pub fn decode_line(line: &str) -> Option<Incoming> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    let parsed: Value = serde_json::from_str(trimmed).ok()?;
    let frame = parsed.as_object()?;

    let id = frame.get("id").and_then(request_id);
    let method = frame.get("method").and_then(Value::as_str);

    match (id, method) {
        (Some(id), Some(method)) => Some(Incoming::Request {
            id,
            method: method.to_owned(),
        }),
        (Some(id), None) => Some(Incoming::Response {
            id,
            outcome: outcome_of(frame),
        }),
        (None, Some(method)) => Some(Incoming::Notification(notification_of(
            method,
            frame.get("params"),
        ))),
        (None, None) => None,
    }
}

fn request_line<P: Serialize>(
    id: &str,
    method: &str,
    params: &P,
) -> Result<String, serde_json::Error> {
    let frame = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": serde_json::to_value(params)?,
    });

    Ok(format!("{frame}\n"))
}

fn request_id(value: &Value) -> Option<RequestId> {
    match value {
        Value::String(text) => Some(RequestId::Text(text.clone())),
        Value::Number(number) => number.as_i64().map(RequestId::Number),
        _other => None,
    }
}

fn outcome_of(frame: &serde_json::Map<String, Value>) -> Result<Value, ErrorBody> {
    // 官方判读：error 成员是对象才算错误应答；code 只认数字，message 只认字符
    // 串，缺省句逐字同官方；data 原样保留。
    if let Some(error) = frame.get("error").and_then(Value::as_object) {
        return Err(ErrorBody {
            code: error.get("code").and_then(Value::as_i64),
            message: error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("JSON-RPC error")
                .to_owned(),
            data: error.get("data").cloned(),
        });
    }

    Ok(frame.get("result").cloned().unwrap_or(Value::Null))
}

fn notification_of(method: &str, params: Option<&Value>) -> Notification {
    // 官方 objectParams：params 不是对象就当空表。
    let params = Value::Object(
        params
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default(),
    );

    let decoded = match method {
        "session.event" => serde_json::from_value(params).map(Notification::SessionEvent),
        "session.status" => serde_json::from_value(params).map(Notification::SessionStatus),
        "subagent.started" => serde_json::from_value(params).map(Notification::SubagentStarted),
        "subagent.finished" => serde_json::from_value(params).map(Notification::SubagentFinished),
        _other => {
            return Notification::Other {
                method: method.to_owned(),
            };
        }
    };

    decoded.unwrap_or_else(|_error| Notification::Other {
        method: method.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, reason = "测试里的意外就该当场炸出来")]
    #![allow(clippy::panic, reason = "同上")]
    #![allow(
        clippy::indexing_slicing,
        reason = "测试里索引缺失即 panic，正合断言之意"
    )]

    use serde_json::json;

    use super::*;

    #[test]
    fn decodes_session_event_notification() {
        let line = r#"{"jsonrpc":"2.0","method":"session.event","params":{"sessionId":"s1","event":{"type":"assistant/chunk","text":"你好"}}}"#;

        let Some(Incoming::Notification(Notification::SessionEvent(event))) = decode_line(line)
        else {
            panic!("该判读成会话事件");
        };

        assert_eq!(event.session_id, "s1");
        assert_eq!(event.event, json!({"type":"assistant/chunk","text":"你好"}));
    }

    #[test]
    fn decodes_status_as_turn_boundary() {
        let line = r#"{"jsonrpc":"2.0","method":"session.status","params":{"sessionId":"s1","status":"idle"}}"#;

        let Some(Incoming::Notification(Notification::SessionStatus(status))) = decode_line(line)
        else {
            panic!("该判读成状态迁移");
        };

        assert_eq!(status.status, SessionStatus::Idle);
    }

    #[test]
    fn decodes_prompt_receipt_response() {
        let line = r#"{"jsonrpc":"2.0","id":"req_1","result":{"messageId":"m1"}}"#;

        let Some(Incoming::Response { id, outcome }) = decode_line(line) else {
            panic!("该判读成应答");
        };

        assert_eq!(id, RequestId::Text("req_1".to_owned()));

        let receipt: SessionPromptResult =
            serde_json::from_value(outcome.expect("这是一条成功应答")).expect("回执形状");
        assert_eq!(receipt.message_id, "m1");
    }

    #[test]
    fn decodes_error_response_with_code_and_data() {
        let line = r#"{"jsonrpc":"2.0","id":7,"error":{"code":-32603,"message":"boom","data":{"detail":1}}}"#;

        let Some(Incoming::Response { id, outcome }) = decode_line(line) else {
            panic!("该判读成应答");
        };

        assert_eq!(id, RequestId::Number(7));

        let error = outcome.expect_err("这是一条错误应答");
        assert_eq!(error.code, Some(-32603));
        assert_eq!(error.message, "boom");
        assert_eq!(error.data, Some(json!({"detail":1})));
    }

    #[test]
    fn ignores_blank_and_malformed_lines() {
        assert_eq!(decode_line(""), None);
        assert_eq!(decode_line("   "), None);
        assert_eq!(decode_line("not json"), None);
        assert_eq!(decode_line(r#""just a string""#), None);
        assert_eq!(decode_line("[1,2,3]"), None);
    }

    #[test]
    fn keeps_unfamiliar_notifications_for_tracing() {
        let unknown = r#"{"jsonrpc":"2.0","method":"session.approval","params":{}}"#;
        assert_eq!(
            decode_line(unknown),
            Some(Incoming::Notification(Notification::Other {
                method: "session.approval".to_owned()
            }))
        );

        // 认识的方法、对不上的形状：同样保留方法名交 trace，不静默丢。
        let drifted = r#"{"jsonrpc":"2.0","method":"session.status","params":{"sessionId":"s1","status":"paused"}}"#;
        assert_eq!(
            decode_line(drifted),
            Some(Incoming::Notification(Notification::Other {
                method: "session.status".to_owned()
            }))
        );
    }

    #[test]
    fn answers_server_requests_with_method_not_found() {
        let line = r#"{"jsonrpc":"2.0","id":"srv_1","method":"session/approve","params":{}}"#;

        let Some(Incoming::Request { id, method }) = decode_line(line) else {
            panic!("该判读成请求");
        };

        let reply = method_not_found_line(&id, &method);
        let parsed: Value = serde_json::from_str(reply.trim()).expect("应答该是合法 JSON");
        assert_eq!(parsed["id"], json!("srv_1"));
        assert_eq!(parsed["error"]["code"], json!(-32601));
        assert_eq!(
            parsed["error"]["message"],
            json!("method not found: session/approve")
        );
    }

    #[test]
    fn encodes_the_three_requests() {
        let init = initialize_line(
            "req_1",
            &InitializeParams {
                cwd: "C:/work".to_owned(),
                provider: "deepseek-official".to_owned(),
                model: "deepseek-v4-pro".to_owned(),
                max_tokens: None,
            },
        )
        .expect("握手参数可序列化");

        assert!(init.ends_with('\n'), "每帧一行，行尾换行");
        assert_eq!(init.matches('\n').count(), 1, "紧凑单行");

        let parsed: Value = serde_json::from_str(init.trim()).expect("合法 JSON");
        assert_eq!(
            parsed,
            json!({
                "jsonrpc": "2.0",
                "id": "req_1",
                "method": "initialize",
                "params": { "cwd": "C:/work", "provider": "deepseek-official", "model": "deepseek-v4-pro" },
            }),
            "maxTokens 缺席时不写这一格"
        );

        let prompt = prompt_line(
            "req_2",
            &SessionPromptParams {
                session_id: "s1".to_owned(),
                content_blocks: vec![json!({"type":"text","text":"hi"})],
            },
        )
        .expect("提问参数可序列化");
        let parsed: Value = serde_json::from_str(prompt.trim()).expect("合法 JSON");
        assert_eq!(
            parsed["params"],
            json!({"sessionId":"s1","contentBlocks":[{"type":"text","text":"hi"}]})
        );

        let shutdown = shutdown_line("req_3");
        let parsed: Value = serde_json::from_str(shutdown.trim()).expect("合法 JSON");
        assert_eq!(parsed["method"], json!("shutdown"));
        assert_eq!(parsed["params"], json!({}));
    }

    #[test]
    fn reads_the_handshake_identity() {
        let result = json!({"serverInfo":{"name":SERVER_NAME,"version":"0.1.0-rc.5"}});

        let parsed: InitializeResult = serde_json::from_value(result).expect("身份形状");
        assert_eq!(parsed.server_info.name, SERVER_NAME);
    }
}
