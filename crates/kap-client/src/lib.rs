//! kap（Kimi Code 本地服务）的客户端：生成的协议模型、进程与链路、会话与帧。

pub mod error;
pub mod generated;
mod model_catalog;
pub use model_catalog::{
    CatalogImport, CatalogModel, CatalogProvider, Model, ModelCatalogOperation,
    ModelCatalogSnapshot, Provider, ProviderInput, ProviderModelInput, ProviderReplacement,
    RegistryImport,
};

mod compatibility;
mod connection;
mod frame;
mod http;
mod interaction;
mod link;
mod policy;
mod process;
mod recorder;
mod run_slot;
mod session;
mod trace;
pub mod translate;

pub use error::{DecodeError, EnvelopeError, KapError, Refusal, Result};

pub use generated::{events, rest};

pub use frame::{PROMPT_ADMITTED, RunFrame};
pub use interaction::desk::{PermissionDesk, QuestionDesk};
pub use interaction::permission::{ApprovalResponse, Decision, Scope};
pub use interaction::question::{
    AnswerMethod, QuestionAnswer, QuestionGroup, QuestionItem, QuestionOption, QuestionOutcome,
    QuestionResponse,
};
pub use process::controlled_home::write_config_atomically;
pub use process::custom_agents::{
    CustomAgentCatalog, CustomAgentFile, CustomAgentFileError, delete_custom_agent,
    list_custom_agents, save_custom_agent,
};
pub use process::daemon::{Daemon, DaemonIntent, Reaction};
pub use process::install::{
    InstallState, InstallStatus, PackageManager, first_semver, install_package, install_state_of,
    latest_version, owner_of, preferred_manager, reported_version,
};
pub use process::profile::{
    ControlledHome, InstallSpec, ProcessEnvironment, args_of, declared_env_of, home_var_of,
    install_spec_of, is_npm_package_name, is_plain_directory_name, launch_env, own_home_of,
    program_of, unset_env_of,
};
pub use process::program::{Launcher, hide_console, resolve_launcher, resolve_program};
pub use recorder::{FrameSink, RecordedEvent, Recorder, SeqLine};
pub use run_slot::RunSlot;
pub use session::driver::connect;
pub use session::{
    AgentClient, AgentConnection, AgentSpawn, Capability, CapabilityInstall, CapabilityReadiness,
    ConfigChoice, ConfigControl, ConfigPurpose, ConfigSelection, Cursor, GoalSnapshot, Handshake,
    McpServer, McpStatus, MediaBytes, OpenedSession, PromptAttachment, PromptSkill, SessionBook,
    SessionEntry, SessionEvent, SessionEvents, SessionUsageSnapshot, Skill, apply_configurations,
    controls, goal_snapshot, select_config, selector_patch,
};

pub use poietica_conversation::link::LinkState;

/// 业务成败看 code（快照的约定），不看 HTTP 状态。
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
            code: 1,
            msg: "refused".to_owned(),
            data: None,
            request_id: None,
            details: None,
        });
        assert!(matches!(
            refused,
            Err(EnvelopeError::Refused { code: 1, .. })
        ));
    }

    #[test]
    fn session_event_routing_fields_decode_from_real_wire_shape() {
        let raw = r#"{
            "type": "assistant.delta",
            "seq": 12,
            "epoch": "e1",
            "volatile": false,
            "session_id": "s1",
            "timestamp": "2026-01-01T00:00:00Z",
            "payload": { "type": "assistant.delta", "agentId": "main" }
        }"#;
        let frame: events::SessionEventFrame =
            serde_json::from_str(raw).expect("real KAP event routing fields must decode");
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
                agent_filter: None,
            },
        };
        let raw = serde_json::to_string(&frame).expect("serialize");
        assert!(raw.contains(r#""type":"subscribe""#));
        let back: events::ClientFrame = serde_json::from_str(&raw).expect("round trip");
        assert_eq!(back, frame);
    }
}

mod completion;
pub use completion::{PromptObservation, observe_prompt};
