//! The Agent Client Protocol client, over a locally spawned agent process.
//!
//! Three rules shape this crate.
//!
//! The protocol handlers never synthesise a protocol error out of one of our
//! own failures. A failure on this side is recorded and surfaced by the driver
//! once the run ends; reporting it back to the agent as a JSON-RPC error would
//! invite it to react to a fault that is not its own.
//!
//! A session outlives a turn, and a connection outlives a session. The
//! process is started once; sessions, prompts, cancellation and shutdown
//! arrive afterwards as commands, and several of them may be in flight at
//! once. One turn at a time is a rule of a session, not of a connection. Because the handlers live as long as the connection and a recorder
//! lives only as long as one run, the two meet through a slot rather than by
//! ownership.
//!
//! A permission request is a question, not a formality. The handler waits at
//! the desk for a real answer, and the fallback refusal is used only where
//! there is nobody to ask.

mod commands;
mod config;
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
pub use config::{ConfigChoice, ConfigControl, ConfigPurpose, controls};
pub use desk::PermissionDesk;
pub use driver::connect;
pub use error::{AcpError, Refusal, Result};
pub use frame::{
    ACP_UPDATE, FrameNotification, PERMISSION_REQUESTED, PERMISSION_RESOLVED, RUN_FAILED,
    RUN_FINISHED, RUN_STARTED, RunFrame,
};
pub use permission::{Decision, answers, decide};
pub use program::resolve_program;
pub use recorder::{FrameSink, Frames, RecordedEvent, Recorder, SeqLine};
pub use run_slot::{Listening, RunSlot};
pub use session::{
    AgentConnection, AgentSpawn, CommandReport, CommandReports, Handshake, OpenedSession,
    SelectorReport, SelectorReports, SessionEntry,
};
pub use sessions::SessionBook;
pub use stderr::StderrLog;
