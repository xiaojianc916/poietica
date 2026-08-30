//! 本机索引：这台机器上有过什么 —— 对话、附件、帧、工作台、用量、处置账。
//!
//! 与 projection 的分界是可否重建：投影删了能从事件重算，索引里的标题、位置、
//! 归属是用户与本机的决定，没有事件能重建它们。

pub mod attachments;
pub mod cursors;
pub mod disposals;
pub mod store;
pub mod threads;
pub mod usage;
pub mod workbench;

pub use attachments::ThreadAttachment;
pub use cursors::SessionCursor;
pub use store::AgentStore;
pub use threads::{ThreadSummary, TitleSource};
pub use usage::{SessionUsage, TokenDay};
