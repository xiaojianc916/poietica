//! 桥的线上形状：一行一条 JSON，双向。
//!
//! 这是全仓唯一一处知道「桥说什么」的地方。判别式与字段名与
//! packages/agent-bridge/src/protocol.ts 逐字对应 —— 那一份是产地，这里是读者。
//! 两侧改名必须同一次改完：名字对不上时 serde 会把帧静默丢成 None，不是编译错。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 桥自己的协议版本；对不上就拒绝这条连接，而不是猜字段。
pub const PROTOCOL_VERSION: u32 = 2;

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
        /// 这条对话记下的工作区，找会话文件要按它扫。
        cwd: String,
    },
    Prompt {
        id: String,
        text: String,
        attachments: Vec<String>,
        skills: Vec<PromptSkill>,

        #[serde(rename = "promptId")]
        prompt_id: String,
    },
    Cancel {
        id: String,
    },
    Steer {
        id: String,
        text: String,
    },
    /// 回答一次工具授权。decision 与 scope 是产品那三颗按钮的取值域。
    AnswerPermission {
        id: String,
        #[serde(rename = "requestId")]
        request_id: String,
        decision: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        scope: Option<String>,
    },
    /// 回答任意一个对话框：原样转发上游 extension_ui_response 的载荷。
    AnswerDialog {
        id: String,
        #[serde(rename = "requestId")]
        request_id: String,
        response: Value,
    },
    Selectors {
        id: String,
    },
    Select {
        id: String,
        #[serde(rename = "configId")]
        config_id: String,
        value: String,
        /// 与这次改动一起交上去的一段文字（目标那一格用它当 objective）。
        ///
        /// 可缺席，且只对认它的那一格有意义 —— 别的选择器忽略它，不是把它塞进 value。
        #[serde(skip_serializing_if = "Option::is_none")]
        input: Option<String>,
    },
    /// 目标模式此刻的事实；`data.goal` 为 null 就是没有目标。
    Goal {
        id: String,
    },
    /// 屏幕经过的一页（打开一条会话时的基线）。
    Transcript {
        id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "agentId")]
        agent_id: String,
        #[serde(rename = "beforeTurn")]
        before_turn: Option<String>,
    },
    /// 从某个水位起的增量。
    TranscriptOps {
        id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "agentId")]
        agent_id: String,
        #[serde(rename = "sinceSeq")]
        since_seq: i64,
    },
    Sessions {
        id: String,
    },
    /// agent 自己报的能力清单。
    Capabilities {
        id: String,
    },
    /// agent 的浏览器控制设置。
    BrowserSettings {
        id: String,
    },
    /// 写浏览器控制设置；缺席的格不改，`cdp_url` 空串即清掉。
    SetBrowserSettings {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        enabled: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        headless: Option<bool>,
        #[serde(rename = "cdpUrl", skip_serializing_if = "Option::is_none")]
        cdp_url: Option<String>,
    },
    Skills {
        id: String,
    },
    McpServers {
        id: String,
    },
    /// agent 自己那份设置目录；`tab` 缺席或 null 就是整份。
    SettingsCatalog {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        tab: Option<String>,
    },
    /// 改 agent 自己的一个设置：走它自己的持久层，由它自己热重载。
    ///
    /// `value` 故意是通用 JSON：类型由 agent 的 schema 说了算，这一侧不折算。
    SetSetting {
        id: String,
        path: String,
        value: Value,
    },
    /// 模型目录的一次读或一次改。
    ModelCatalog {
        id: String,
        operation: Value,
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
    /// agent 要问一个对话框。`request` 是上游 RpcExtensionUIRequest 的原样形状。
    ///
    /// ask 工具的题组不走这一支（它有自己的 `questions_asked`）：同一件事两条路
    /// 就会一半认得一半认不得。授权那一类（method=select）由本层翻成 permission 帧。
    DialogRequested {
        #[serde(rename = "sessionId")]
        session_id: String,
        request: Value,
    },
    /// agent 的 ask 工具在等人答一组题。
    ///
    /// `questions` 已经是产品形状（protocol.ts 的 AskedQuestion，camelCase）：omp 那份
    /// 载荷（选项只有标签、还有画不出的 preview）由桥折过，agent 专属形状不进通用层
    /// （AGENTS.md §4）。`request_id` 是上游那次对话框的号，答复挂同一个号回去。
    QuestionsAsked {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "requestId")]
        request_id: String,
        questions: Value,
    },
    Selectors {
        #[serde(rename = "sessionId")]
        session_id: String,
        controls: Vec<Value>,
        /// 此刻的目标；缺席即没有目标，与「这一格是空」不是一回事。
        #[serde(default)]
        goal: Option<Value>,
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
    use serde_json::{Value, json};

    #[test]
    fn a_command_round_trips_through_one_line() {
        let command = Command::Prompt {
            id: "p1".to_owned(),
            text: "读一下 README".to_owned(),
            prompt_id: "turn-1".to_owned(),
            attachments: vec!["/tmp/a.png".to_owned()],
            skills: Vec::new(),
        };

        let line = encode(&command).expect("encode");
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1);
        assert!(line.contains(r#""type":"prompt""#));
        assert!(line.contains(r#""id":"p1""#));
        /* 账本那个号必须真的上 wire：屏幕靠它把这一轮认回那条提交记录。 */
        assert!(line.contains(r#""promptId":"turn-1""#));
    }

    #[test]
    fn every_command_carries_the_discriminator_the_bridge_matches_on() {
        for (command, expected) in [
            (Command::Selectors { id: "x".to_owned() }, "selectors"),
            (Command::Cancel { id: "x".to_owned() }, "cancel"),
            (Command::Shutdown { id: "x".to_owned() }, "shutdown"),
            (Command::McpServers { id: "x".to_owned() }, "mcp_servers"),
            (
                Command::SettingsCatalog {
                    id: "x".to_owned(),
                    tab: None,
                },
                "settings_catalog",
            ),
            (
                Command::SetSetting {
                    id: "x".to_owned(),
                    path: "browser.headless".to_owned(),
                    value: Value::Bool(false),
                },
                "set_setting",
            ),
        ] {
            let line = encode(&command).expect("encode");
            assert!(line.contains(&format!(r#""type":"{expected}""#)), "{line}");
        }
    }

    /// 改一格设置：路径与值原样上 wire，值不折算（类型由 agent 的 schema 说了算）。
    #[test]
    fn a_set_setting_carries_the_path_and_the_value_verbatim() {
        let command = Command::SetSetting {
            id: "s1".to_owned(),
            path: "browser.headless".to_owned(),
            value: serde_json::json!({ "nested": [1, true, null] }),
        };

        let line = encode(&command).expect("encode");

        assert!(line.contains(r#""path":"browser.headless""#), "{line}");
        assert!(
            line.contains(r#""value":{"nested":[1,true,null]}"#),
            "{line}"
        );
    }

    /// 整份目录时 `tab` 缺席，不是空串：`null` 与「这一栏」在桥那边是两件事。
    #[test]
    fn a_catalog_read_without_a_tab_omits_the_field() {
        let whole = encode(&Command::SettingsCatalog {
            id: "s1".to_owned(),
            tab: None,
        })
        .expect("encode");
        let tabbed = encode(&Command::SettingsCatalog {
            id: "s2".to_owned(),
            tab: Some("tools".to_owned()),
        })
        .expect("encode");

        assert!(
            !whole.contains("tab"),
            "no tab means the whole catalog: {whole}"
        );
        assert!(tabbed.contains(r#""tab":"tools""#), "{tabbed}");
    }

    #[test]
    fn a_load_session_names_the_session_and_the_workspace_to_scan() {
        let command = Command::LoadSession {
            id: "l1".to_owned(),
            session_id: "s1".to_owned(),
            cwd: "D:\\work".to_owned(),
        };

        let line = encode(&command).expect("encode");
        assert!(line.contains(r#""type":"load_session""#));
        assert!(line.contains(r#""sessionId":"s1""#));
        assert!(line.contains(r#""cwd":"D:\\work""#));
    }

    #[test]
    fn the_real_ready_frame_decodes() {
        let raw = r#"{"type":"ready","protocolVersion":2,"agentVersion":"18.3.0"}"#;

        assert_eq!(
            decode(raw).expect("ready"),
            Frame::Ready {
                protocol_version: 2,
                agent_version: "18.3.0".to_owned(),
            }
        );
    }

    #[test]
    fn a_questions_asked_event_carries_the_request_id_that_the_answer_rides() {
        let raw = r#"{"type":"event","event":{"kind":"questions_asked","sessionId":"s1","requestId":"d7","questions":[{"id":"q0","question":"哪种配色？","options":[{"id":"o0","label":"深色"}],"multiSelect":false,"allowOther":true}]}}"#;

        let decoded = decode(raw).expect("questions_asked");

        let Frame::Event {
            event:
                Event::QuestionsAsked {
                    session_id,
                    request_id,
                    questions,
                },
        } = decoded
        else {
            unreachable!("this fixture is a questions_asked event");
        };

        assert_eq!(session_id, "s1");
        /* 答复挂这个号回去：桥按它认那次 askDialog，换一个号就没有人在等。 */
        assert_eq!(request_id, "d7");
        assert_eq!(
            questions.as_array().map(Vec::len),
            Some(1),
            "the questions keep their product shape verbatim"
        );
    }

    #[test]
    fn a_response_without_data_still_decodes() {
        let raw = r#"{"type":"response","id":"r1"}"#;

        assert_eq!(
            decode(raw).expect("response"),
            Frame::Response {
                id: "r1".to_owned(),
                data: Value::Null,
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
