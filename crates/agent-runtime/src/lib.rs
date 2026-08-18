// kap-exports
//! kap（Kimi Code 本地服务）的客户端运行时：起 kimi web、走 REST +
//! WebSocket、把一次运行记成帧。
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
//! A permission request is a question, not a formality. The handler waits at
//! the desk for a real answer, and the fallback refusal is used only where
//! there is nobody to ask.

pub use driver::connect as connect_kap;

mod commands;
mod config;
mod credentials;
mod desk;
mod driver;
mod error;
mod frame;
mod permission;
mod program;
mod recorder;
mod run_slot;
mod session;
mod sessions;
mod stderr;
mod trace;

pub use commands::{AgentClient, PromptImage};
pub use config::{ConfigChoice, ConfigControl, ConfigPurpose, controls, selector_patch};
pub use credentials::{
    alias_has_usable_credentials, alias_is_declared, secret_from_config, tails_from_config,
    usable_default_model,
};
pub use desk::PermissionDesk;
pub use error::{KapError, Refusal, Result};
pub use frame::{
    KAP_EVENT, PERMISSION_REQUESTED, PERMISSION_RESOLVED, RUN_FAILED, RUN_FINISHED, RUN_STARTED,
    RunFrame, kap_event,
};
pub use permission::{Decision, kap_answers, kap_options, kap_response};
pub use program::resolve_program;
pub use recorder::{FrameSink, RecordedEvent, Recorder, SeqLine, now_millis};
pub use run_slot::RunSlot;
pub use session::{
    AgentConnection, AgentSpawn, CanCancelSession, CanDeleteSession, CanForkSession,
    CanLoadSession, Handshake, OpenedSession, SessionEntry, SessionEvent, SessionEvents,
};
pub use sessions::SessionBook;
pub use stderr::StderrLog;
