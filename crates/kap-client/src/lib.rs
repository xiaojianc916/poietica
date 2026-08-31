//! kap（Kimi Code 本地服务）的客户端：生成的协议模型、进程与链路、会话与帧。
//!
//! `generated/` 由 tools/contract/generate-kap.ts 从 contracts/kap 的快照生成，
//! 禁手改；本 crate 其余部分只做信封语义与解码判据，不添加协议形状。
//!
//! Three rules shape this crate.
//!
//! A failure on this side is recorded and surfaced by the driver once the run
//! ends; it is never reported back to the agent as if it were the agent's own.
//!
//! A session outlives a turn, and a connection outlives a session. The
//! process is started once; sessions, prompts, cancellation and shutdown
//! arrive afterwards as commands, and several of them may be in flight at
//! once. One turn at a time is a rule of a session, not of a connection.
//! Because the handlers live as long as the connection and a recorder lives
//! only as long as one run, the two meet through a slot rather than by
//! ownership.
//!
//! Asking a human is not a formality, and it is not one kind of ask. An
//! approval is answered with one of kap's three decisions; a question group
//! takes whatever its own multi_select and allow_other allow. They therefore
//! wait at two desks, and a handler blocks on its own desk until a real answer
//! arrives rather than inventing one.

pub mod error;
pub mod generated;

mod connection;
mod frame;
mod history;
mod interaction;
mod link;
mod process;
mod recorder;
mod run_slot;
mod session;
mod trace;
pub mod translate;

pub use error::{DecodeError, EnvelopeError, KapError, Refusal, Result};

pub use generated::{events, rest};

pub use frame::{KAP_EVENT, PROMPT_ADMITTED, RUN_FINISHED, RunFrame, kap_event};
pub use history::{
    AGENT_FIELD, ASSISTANT_DELTA, DELTA_FIELD, MAIN_AGENT, TYPE_FIELD, compact_history,
};
pub use interaction::desk::{PermissionDesk, QuestionDesk};
pub use interaction::permission::{Decision, Scope};
pub use interaction::question::{
    AnswerMethod, QuestionAnswer, QuestionGroup, QuestionItem, QuestionOption, QuestionOutcome,
    QuestionResponse,
};
pub use process::controlled_home::{
    alias_has_usable_credentials, alias_is_declared, secret_from_config, set_default_model,
    tails_from_config, usable_default_model, write_config_atomically,
};
pub use process::custom_agents::{
    CustomAgentCatalog, CustomAgentFile, CustomAgentFileError, delete_custom_agent,
    list_custom_agents, save_custom_agent,
};
pub use process::daemon::{Daemon, DaemonIntent, DaemonPhase, Reaction};
pub use process::install::{
    InstallState, InstallStatus, PackageManager, first_semver, install_package, install_state_of,
    latest_version, owner_of, preferred_manager, reported_version,
};
pub use process::profile::{
    ControlledHome, InstallSpec, args_of, declared_env_of, home_var_of, install_spec_of,
    is_npm_package_name, is_plain_directory_name, launch_env, own_home_of, program_of,
};
pub use process::program::{Launcher, hide_console, resolve_launcher, resolve_program};
pub use recorder::{FrameSink, RecordedEvent, Recorder, SeqLine};
pub use run_slot::RunSlot;
pub use session::driver::connect;
pub use session::{
    AgentClient, AgentConnection, AgentSpawn, ConfigChoice, ConfigControl, ConfigPurpose,
    ConfigSelection, Cursor, GoalSnapshot, Handshake, McpServer, McpStatus, McpTransport,
    OpenedSession, PromptAttachment, PromptSkill, SessionBook, SessionEntry, SessionEvent,
    SessionEvents, SessionUsageSnapshot, Skill, apply_configurations, controls, goal_snapshot,
    select_config, selector_patch,
};

/// 链路态的词汇住在领域那侧；这里只是转发，让消费者不必两处 import。
pub use poietica_conversation::link::LinkState;

/// 解一条 REST 应答信封。业务成败看 code（快照的约定），不看 HTTP 状态。
///
/// 成功的 data 缺席即协议破坏；失败的 data 一律不解析（错误分支里它是 null）。
pub fn envelope_data<T: serde::de::DeserializeOwned>(
    envelope: rest::RestEnvelope,
) -> std::result::Result<T, EnvelopeError> {
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
pub fn server_frame(raw: &str) -> std::result::Result<events::ServerFrame, DecodeError> {
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
        let refused: std::result::Result<String, _> = envelope_data(rest::RestEnvelope {
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
