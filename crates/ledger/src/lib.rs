//! 本机账本与索引；屏幕经过的权威仍是 agent transcript。
//!
//! 领域只看得见 conversation::ports 里的 trait，这一层是它在 SQLite 上的实现。

pub mod automation;
pub mod connection;
pub mod conversation;
pub mod error;
pub mod execution;
pub mod index;
pub mod migrations;
pub mod projection;

pub use conversation::SqliteLedger;
pub use conversation::screen::{FrameCursor, FramePage, TurnMark, screen_frame};
pub use error::LedgerError;
