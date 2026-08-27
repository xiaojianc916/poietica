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
//! Asking a human is not a formality, and it is not one kind of ask. An
//! approval is answered with one of kap's three decisions; a question group
//! takes whatever its own multi_select and allow_other allow. They therefore
//! wait at two desks, and a handler blocks on its own desk until a real answer
//! arrives rather than inventing one.

pub use driver::connect;

mod commands;
mod config;
mod credentials;
mod desk;
mod driver;
mod error;
mod frame;
mod history;
mod link;
mod permission;
mod program;
mod question;
mod recorder;
mod run_slot;
mod selection;
mod session;
mod sessions;
mod stderr;
mod trace;

pub use commands::{AgentClient, PromptAttachment, PromptSkill};
pub use config::{
    ConfigChoice, ConfigControl, ConfigPurpose, GoalSnapshot, controls, goal_snapshot,
    selector_patch,
};
pub use credentials::{
    alias_has_usable_credentials, alias_is_declared, secret_from_config, tails_from_config,
    usable_default_model,
};
pub use desk::{PermissionDesk, QuestionDesk};
pub use error::{KapError, Refusal, Result};
pub use frame::{PROMPT_ADMITTED, RUN_FINISHED, RunFrame, kap_event};
pub use history::compact_history;
pub use link::LinkState;
pub use permission::{Decision, Scope};
pub use program::{Launcher, hide_console, resolve_launcher, resolve_program};
pub use question::{
    AnswerMethod, QuestionAnswer, QuestionGroup, QuestionItem, QuestionOption, QuestionOutcome,
    QuestionResponse,
};
pub use recorder::{FrameSink, RecordedEvent, Recorder, SeqLine};
pub use run_slot::RunSlot;
pub use selection::{ConfigSelection, apply_configurations, select_config};
pub use session::{
    AgentConnection, AgentSpawn, Cursor, Handshake, McpServer, McpStatus, McpTransport,
    OpenedSession, SessionEntry, SessionEvent, SessionEvents, SessionUsageSnapshot, Skill,
};
pub use sessions::SessionBook;
