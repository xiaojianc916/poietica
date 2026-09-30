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
        attachments: Vec<WireAttachment>,
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
    /// agent 自己的会话清单；工作区由这条连接锚着，所以不带 cwd。
    Sessions {
        id: String,
    },
    /// 从一条会话分叉出新的那条，丢掉尾部 `dropTurns` 轮。
    ///
    /// 宿主自己的「分叉」是一次现场换会话：SDK 的 AgentSession#branch / #fork
    /// 都会把这条连接的活会话换成新的那条（agent-session.ts:8573 与 :10060），
    /// 所以应答与新开、重装同形 —— 回来的号要接过去。
    ForkSession {
        id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "dropTurns")]
        drop_turns: u32,
    },
    /// 删掉一条会话：本层给号，由桥按号找到文件（它认路径，见 protocol.ts）。
    DeleteSession {
        id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    /// 把一条会话导成一页 HTML，写到 `destination`（绝对路径）。
    ExportSession {
        id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
        destination: String,
    },
    /// 把一条会话传到 agent 自己的分享服务，换回一条链接。
    ///
    /// 这是唯一会把对话正文送出本机的命令。应答只取 `url` 与 `truncated` 两格：
    /// 脱敏由桥按 agent 自己的设置办（protocol.ts 的 share_session），本层不碰。
    ShareSession {
        id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    /// agent 自己报的能力清单。
    Capabilities {
        id: String,
    },
    /// 开关一项本机能力（omp 里只有开与关：桌面控制是构建期编进来的 eval 前奏）。
    InstallCapability {
        id: String,
        #[serde(rename = "capabilityId")]
        capability_id: String,
        enabled: bool,
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
    /// agent 自己那份设置目录。
    SettingsCatalog {
        id: String,
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

/// 随一句话带上的一个附件，线上形状（protocol.ts 的 prompt.attachments 一格）。
///
/// 四格缺一不可：桥按 `kind` 分派，`mime` 是 SDK `ImageContent.mimeType` 的唯一来源，
/// `name` 是屏幕上那张卡片的显示名。omp 的 `PromptOptions.images` 只收 base64，
/// 读盘的活在桥那一侧。`mime` 必须是进门的内容判据（`crates/asset/src/formats.rs`
/// 的 `classify()` 按文件头嗅出），不是扩展名：粘贴的图叫 `pasted-<uuid>`，
/// 按扩展名反推会把好图说成 `application/octet-stream`，供应商直接拒收。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WireAttachment {
    pub path: String,
    pub kind: String,
    pub mime: String,
    pub name: String,
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

    use super::{Command, Event, Frame, WireAttachment, decode, encode};
    use serde_json::{Value, json};

    #[test]
    fn a_command_round_trips_through_one_line() {
        let command = Command::Prompt {
            id: "p1".to_owned(),
            text: "读一下 README".to_owned(),
            prompt_id: "turn-1".to_owned(),
            attachments: vec![
                WireAttachment {
                    path: "/tmp/a.png".to_owned(),
                    kind: "image".to_owned(),
                    mime: "image/png".to_owned(),
                    name: "a.png".to_owned(),
                },
                WireAttachment {
                    path: "/tmp/notes.pdf".to_owned(),
                    kind: "file".to_owned(),
                    mime: "application/pdf".to_owned(),
                    name: "notes.pdf".to_owned(),
                },
            ],
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

    /// 附件是对象不是裸路径：桥靠 `kind` 分派、`mime` 出 mimeType、`name` 出显示名。
    /// 四格与 protocol.ts 逐字对应，对不上是静默缺格（模块头那条），所以全钉住 ——
    /// `mime` 尤其要钉：扩展名不是判据（粘贴的图叫 `pasted-<uuid>`），写错是**静默 None**。
    #[test]
    fn an_attachment_carries_its_path_kind_mime_and_name() {
        let line = encode(&Command::Prompt {
            id: "p2".to_owned(),
            text: String::new(),
            prompt_id: "turn-2".to_owned(),
            attachments: vec![
                WireAttachment {
                    path: "D:\\media\\pasted-7f3a".to_owned(),
                    kind: "image".to_owned(),
                    mime: "image/png".to_owned(),
                    name: "pasted-7f3a".to_owned(),
                },
                WireAttachment {
                    path: "D:\\media\\notes.pdf".to_owned(),
                    kind: "file".to_owned(),
                    mime: "application/pdf".to_owned(),
                    name: "notes.pdf".to_owned(),
                },
            ],
            skills: Vec::new(),
        })
        .expect("encode");

        assert!(
            line.contains(
                r#""attachments":[{"path":"D:\\media\\pasted-7f3a","kind":"image","mime":"image/png","name":"pasted-7f3a"},{"path":"D:\\media\\notes.pdf","kind":"file","mime":"application/pdf","name":"notes.pdf"}]"#
            ),
            "{line}"
        );
    }

    #[test]
    fn every_command_carries_the_discriminator_the_bridge_matches_on() {
        for (command, expected) in [
            (Command::Selectors { id: "x".to_owned() }, "selectors"),
            (Command::Cancel { id: "x".to_owned() }, "cancel"),
            (Command::Shutdown { id: "x".to_owned() }, "shutdown"),
            (Command::McpServers { id: "x".to_owned() }, "mcp_servers"),
            (
                Command::SettingsCatalog { id: "x".to_owned() },
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
            (
                Command::InstallCapability {
                    id: "x".to_owned(),
                    capability_id: "computer-use".to_owned(),
                    enabled: true,
                },
                "install_capability",
            ),
        ] {
            let line = encode(&command).expect("encode");
            assert!(line.contains(&format!(r#""type":"{expected}""#)), "{line}");
        }
    }

    /// 会话生命周期那三条各自带判别式与号；分叉还带要丢几轮。
    #[test]
    fn the_session_lifecycle_commands_carry_their_discriminators() {
        for (command, expected) in [
            (Command::Sessions { id: "x".to_owned() }, "sessions"),
            (
                Command::ForkSession {
                    id: "x".to_owned(),
                    session_id: "s1".to_owned(),
                    drop_turns: 2,
                },
                "fork_session",
            ),
            (
                Command::DeleteSession {
                    id: "x".to_owned(),
                    session_id: "s1".to_owned(),
                },
                "delete_session",
            ),
            (
                Command::ExportSession {
                    id: "x".to_owned(),
                    session_id: "s1".to_owned(),
                    destination: "D:\\out.html".to_owned(),
                },
                "export_session",
            ),
            (
                Command::ShareSession {
                    id: "x".to_owned(),
                    session_id: "s1".to_owned(),
                },
                "share_session",
            ),
        ] {
            let line = encode(&command).expect("encode");
            assert!(line.contains(&format!(r#""type":"{expected}""#)), "{line}");
        }
    }

    /// 分叉要丢几轮是这一条的全部信息量：号给错，分叉点就错一轮。
    #[test]
    fn a_fork_names_the_session_and_how_many_turns_to_drop() {
        let line = encode(&Command::ForkSession {
            id: "c4".to_owned(),
            session_id: "s1".to_owned(),
            drop_turns: 3,
        })
        .expect("encode");

        assert!(line.contains(r#""sessionId":"s1""#), "{line}");
        assert!(line.contains(r#""dropTurns":3"#), "{line}");
    }

    /// 能力那一格必须是 camelCase 的 `capabilityId`，方向也必须真的上 wire：
    /// 桥按这两个名字读，写错是静默 None（或一个永远关不掉的开关）。
    #[test]
    fn an_install_names_the_capability_and_the_direction() {
        let line = encode(&Command::InstallCapability {
            id: "c7".to_owned(),
            capability_id: "computer-use".to_owned(),
            enabled: false,
        })
        .expect("encode");

        assert!(line.contains(r#""type":"install_capability""#), "{line}");
        assert!(line.contains(r#""capabilityId":"computer-use""#), "{line}");
        assert!(line.contains(r#""enabled":false"#), "{line}");
    }

    /// 导出那一格是**磁盘路径**：字节由 agent 自己写，不过这条线。
    #[test]
    fn an_export_carries_the_destination_verbatim() {
        let line = encode(&Command::ExportSession {
            id: "c6".to_owned(),
            session_id: "s1".to_owned(),
            destination: "D:\\reports\\会话.html".to_owned(),
        })
        .expect("encode");

        assert!(line.contains(r#""type":"export_session""#), "{line}");
        assert!(
            line.contains(r#""destination":"D:\\reports\\会话.html""#),
            "{line}"
        );
    }

    /// 分享只带一个会话号：脱敏策略与落点都是 agent 自己的设置，不上 wire。
    #[test]
    fn a_share_names_only_the_session() {
        let line = encode(&Command::ShareSession {
            id: "c7".to_owned(),
            session_id: "s1".to_owned(),
        })
        .expect("encode");

        assert!(line.contains(r#""type":"share_session""#), "{line}");
        assert!(line.contains(r#""sessionId":"s1""#), "{line}");
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

    #[test]
    fn a_settings_catalog_read_needs_no_tab() {
        let line = encode(&Command::SettingsCatalog {
            id: "s1".to_owned(),
        })
        .expect("encode");

        assert!(line.contains(r#""type":"settings_catalog""#), "{line}");
        assert!(!line.contains("tab"), "{line}");
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
