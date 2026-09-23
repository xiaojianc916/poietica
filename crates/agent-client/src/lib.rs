//! oh-my-pi（omp）的客户端：进程与链路、会话与帧。
//!
//! 我们不经 kap，也不让用户装 omp：agent 是随包发的一个可执行文件（packages/
//! agent-bridge 的入口，SDK 编在里面），它以 NDJSON 在 stdio 上说话。本 crate
//! 拥有进程、连接、取消与事件生命周期；TypeScript 只消费落盘后的帧（ADR 0052）。

pub mod error;

mod frame;
mod interaction;
mod model_catalog;
mod policy;
mod process;
mod recorder;
mod run_slot;
mod session;
mod trace;
pub mod translate;
pub mod wire;

pub use error::{AgentError, DecodeError, EnvelopeError, Refusal, Result};

pub use model_catalog::{
    CatalogImport, CatalogModel, CatalogProvider, Model, ModelCatalogOperation,
    ModelCatalogSnapshot, Provider, ProviderInput, ProviderModelInput, ProviderReplacement,
    RegistryImport,
};

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
pub use session::bridge::connect;
pub use session::observe::{PromptObservation, observe_prompt};
pub use session::{
    AgentClient, AgentConnection, AgentSpawn, Capability, CapabilityInstall, CapabilityReadiness,
    ConfigChoice, ConfigControl, ConfigPurpose, ConfigSelection, Cursor, GoalSnapshot, Handshake,
    McpServer, McpStatus, MediaBytes, OpenedSession, PromptAttachment, PromptSkill, SessionBook,
    SessionEntry, SessionEvent, SessionEvents, SessionUsageSnapshot, Skill, apply_configurations,
    select_config,
};

pub use poietica_conversation::link::LinkState;
