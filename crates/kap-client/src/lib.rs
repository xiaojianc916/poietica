//! KAP 协议形状的唯一 Rust 消费面。
//!
//! `generated/` 由 tools/contract/generate-kap.ts 从 contracts/kap 的快照生成，
//! 禁手改；本 crate 其余部分只做信封语义与解码判据，不添加协议形状。

pub mod error;
pub mod generated;

pub use error::{DecodeError, EnvelopeError};

pub use generated::events;
pub use generated::rest;

/// 解一条 REST 应答信封。业务成败看 code（快照的约定），不看 HTTP 状态。
///
/// 成功的 data 缺席即协议破坏；失败的 data 一律不解析（错误分支里它是 null）。
pub fn envelope_data<T: serde::de::DeserializeOwned>(
    envelope: rest::RestEnvelope,
) -> Result<T, EnvelopeError> {
    if envelope.code != 0 {
        return Err(EnvelopeError::Refused {
            code: envelope.code,
            msg: envelope.msg,
        });
    }
    let data = envelope.data.unwrap_or(serde_json::Value::Null);
    serde_json::from_value(data).map_err(EnvelopeError::from)
}

/// 解一条 server 帧。未知 type 走这里报错，由调用方决定丢弃还是计数。
pub fn server_frame(raw: &str) -> Result<events::ServerFrame, DecodeError> {
    serde_json::from_str(raw).map_err(DecodeError::from)
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        reason = "a test proves itself by panicking, so a failed decode must fail the test"
    )]
    use super::*;

    #[test]
    fn envelope_routes_by_code() {
        let refused: Result<String, _> = envelope_data(rest::RestEnvelope {
            code: 40909,
            msg: "dismissed".to_owned(),
            data: None,
            request_id: None,
            details: None,
        });
        assert!(matches!(
            refused,
            Err(EnvelopeError::Refused { code: 40909, .. })
        ));
    }

    #[test]
    fn session_event_envelope_decodes() {
        let raw = r#"{
            "type": "session_event",
            "seq": 12,
            "epoch": "e1",
            "volatile": false,
            "session_id": "s1",
            "timestamp": "2026-01-01T00:00:00Z",
            "payload": { "type": "assistant.delta", "agentId": "main" }
        }"#;
        let frame: events::SessionEventFrame =
            serde_json::from_str(raw).expect("session_event frame must decode");
        assert_eq!(frame.seq, 12);
        assert_eq!(frame.session_id.as_deref(), Some("s1"));
    }

    #[test]
    fn subscribe_frame_round_trips_cursors() {
        let frame = events::ClientFrame::Subscribe {
            id: "id-1".to_owned(),
            payload: events::SubscribeStruct {
                session_ids: vec!["s1".to_owned()],
                cursors: Some(
                    [(
                        "s1".to_owned(),
                        events::ClientHelloCursorsValueStruct {
                            seq: 7,
                            epoch: Some("e1".to_owned()),
                        },
                    )]
                    .into_iter()
                    .collect(),
                ),
                watch_fs: None,
                agent_filter: None,
            },
        };
        let raw = serde_json::to_string(&frame).expect("serialize");
        assert!(raw.contains(r#""type":"subscribe""#));
        let back: events::ClientFrame = serde_json::from_str(&raw).expect("round trip");
        assert_eq!(back, frame);
    }
}
