//! 事件账本：对话的唯一真相落在 SQLite 上，所有视图都从事件重算。
//!
//! 领域只看得见 conversation::ports 里的 trait，这一层是它在 SQLite 上的实现。

pub mod connection;
pub mod conversation;
pub mod error;
pub mod migrations;
pub mod projection;

pub use conversation::SqliteLedger;
pub use error::LedgerError;
