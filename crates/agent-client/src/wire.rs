//! 桥的线上形状：一行一条 JSON，双向。
//!
//! 这是全仓唯一一处知道「桥说什么」的地方。判别式与字段名与
//! packages/agent-bridge/src/protocol.ts 逐字对应 —— 那一份是产地，这里是读者。
//! 两侧改名必须同一次改完：名字对不上时 serde 会把帧静默丢成 None，不是编译错。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 桥自己的协议版本；对不上就拒绝这条连接，而不是猜字段。
pub const PROTOCOL_VERSION: u32 = 1;

/// 单行上限。桥侧的 MAX_FRAME_BYTES 同值；超了说明对端不是我们的桥。
pub const MAX_LINE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    NewSession {
        id: String,
        cwd: String,
    },
    LoadSession {
        id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    Prompt {
        id: String,
        text: String,
        attachments: Vec<String>,
        skills: Vec<PromptSkill>,
    },
    Cancel {
        id: String,
    },
    Steer {
        id: String,
        text: String,
    },
    Selectors {
        id: String,
    },
    Select {
        id: String,
        #[serde(rename = "configId")]
        config_id: String,
        value: String,
    },
    Sessions {
        id: String,
    },
    Skills {
        id: String,
    },
    McpServers {
        id: String,
    },
    Shutdown {
        id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PromptSkill {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Frame {
    Ready {
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
        #[serde(rename = "agentVersion")]
        agent_version: String,
    },
    Response {
        id: String,
        #[serde(default)]
        data: Value,
    },
    Failed {
        id: String,
        message: String,
    },
    Event {
        event: Event,
    },
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Event {
    Transcript {
        #[serde(rename = "sessionId")]
        session_id: String,
        payload: Value,
    },
    /// 这一轮按 agent 自己的说法结束了；本机账本靠它收账。
    TurnEnd {
        #[serde(rename = "sessionId")]
        session_id: String,
        outcome: Outcome,
        #[serde(default)]
        message: Option<String>,
    },
    Selectors {
        #[serde(rename = "sessionId")]
        session_id: String,
        controls: Vec<Value>,
    },
    Usage {
        #[serde(rename = "sessionId")]
        session_id: String,
        usage: Value,
    },
}

/// 一轮的结局。与 frame.rs 的 stop_reason 同一套词，不是第二套。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Completed,
    Cancelled,
    Failed,
}

impl Outcome {
    #[must_use]
    pub const fn stop_reason(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
        }
    }
}

/// 一行 → 一帧。空行不是帧；坏行报错，不吞。
pub fn decode(line: &str) -> Result<Frame, serde_json::Error> {
    serde_json::from_str(line)
}

/// 一条命令 → 一行（带换行）。
pub fn encode(command: &Command) -> Result<String, serde_json::Error> {
    Ok(format!("{}\n", serde_json::to_string(command)?))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, reason = "a broken fixture must fail loudly")]

    use super::{Command, Event, Frame, decode, encode};
    use serde_json::json;

    #[test]
    fn a_command_round_trips_through_one_line() {
        let command = Command::Prompt {
            id: "p1".to_owned(),
            text: "读一下 README".to_owned(),
            attachments: vec!["/tmp/a.png".to_owned()],
            skills: Vec::new(),
        };

        let line = encode(&command).expect("encode");
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1);
        assert!(line.contains(r#""type":"prompt""#));
        assert!(line.contains(r#""id":"p1""#));
    }

    #[test]
    fn every_command_carries_the_discriminator_the_bridge_matches_on() {
        for (command, expected) in [
            (Command::Selectors { id: "x".to_owned() }, "selectors"),
            (Command::Cancel { id: "x".to_owned() }, "cancel"),
            (Command::Shutdown { id: "x".to_owned() }, "shutdown"),
            (Command::McpServers { id: "x".to_owned() }, "mcp_servers"),
        ] {
            let line = encode(&command).expect("encode");
            assert!(line.contains(&format!(r#""type":"{expected}""#)), "{line}");
        }
    }

    #[test]
    fn the_real_ready_frame_decodes() {
        let raw = r#"{"type":"ready","protocolVersion":1,"agentVersion":"18.2.11"}"#;

        assert_eq!(
            decode(raw).expect("ready"),
            Frame::Ready {
                protocol_version: 1,
                agent_version: "18.2.11".to_owned(),
            }
        );
    }

    #[test]
    fn a_response_without_data_still_decodes() {
        let raw = r#"{"type":"response","id":"r1"}"#;

        assert_eq!(
            decode(raw).expect("response"),
            Frame::Response {
                id: "r1".to_owned(),
                data: serde_json::Value::Null,
            }
        );
    }

    #[test]
    fn a_transcript_event_keeps_its_payload_verbatim() {
        let raw = r#"{"type":"event","event":{"kind":"transcript","sessionId":"s1","payload":{"agentId":"main","ops":[]}}}"#;

        let decoded = decode(raw).expect("event");

        let Frame::Event {
            event:
                Event::Transcript {
                    session_id,
                    payload,
                },
        } = decoded
        else {
            unreachable!("this fixture is a transcript event");
        };

        assert_eq!(session_id, "s1");
        assert_eq!(payload, json!({ "agentId": "main", "ops": [] }));
    }

    #[test]
    fn a_failure_names_the_command_it_answers() {
        let raw = r#"{"type":"failed","id":"p1","message":"no session"}"#;

        assert_eq!(
            decode(raw).expect("failed"),
            Frame::Failed {
                id: "p1".to_owned(),
                message: "no session".to_owned(),
            }
        );
    }

    #[test]
    fn a_turn_end_names_its_outcome_in_the_frame_vocabulary() {
        let raw = r#"{"type":"event","event":{"kind":"turn_end","sessionId":"s1","outcome":"cancelled"}}"#;

        let decoded = decode(raw).expect("turn_end");

        let Frame::Event {
            event:
                Event::TurnEnd {
                    session_id,
                    outcome,
                    message,
                },
        } = decoded
        else {
            unreachable!("this fixture is a turn_end event");
        };

        assert_eq!(session_id, "s1");
        assert_eq!(outcome.stop_reason(), "cancelled");
        assert_eq!(message, None);
    }

    #[test]
    fn an_unknown_outcome_is_refused_rather_than_mapped_to_a_wrong_one() {
        let raw =
            r#"{"type":"event","event":{"kind":"turn_end","sessionId":"s1","outcome":"maybe"}}"#;

        assert!(decode(raw).is_err());
    }

    #[test]
    fn an_unknown_frame_is_an_error_rather_than_a_silent_none() {
        assert!(decode(r#"{"type":"invented"}"#).is_err());
        assert!(decode("not json").is_err());
    }
}
