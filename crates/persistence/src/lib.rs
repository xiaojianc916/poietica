//! Local index of conversations.
//!
//! 这个 crate 回答的都是同一类问题：这台机器上有过什么。有哪些对话、它们叫
//! 什么、各自握着谁的哪个会话、各自挂着哪些附件、收到过哪些帧，
//! 以及上一次关掉时工作台开着哪几格。屏幕上那条时间线由 run_events 重放；
//! agent 那侧那份是模型的上下文，由 session/load 让它自己恢复，不参与投影。
//!
//! 附件是第四个问题而不是第一个问题的一部分，理由在 attachments.rs：agent
//! 收到的是用户文件的一份 base64 副本，它没有义务交还，多数 CLI 也确实不
//! 交还。那份字节的主人是这台机器，所以账也记在这台机器上。
//!
//! 也正因为如此，这里没有秘密可保：那份线程元数据的副本，挡不住任何一个能
//! 读到 agent 那份明文全文的人。

mod attachments;
mod connection;
mod cursors;
mod disposals;
mod error;
mod migrations;
mod run_events;
mod store;
mod threads;
mod usage;
mod workbench;

pub use attachments::ThreadAttachment;
pub use cursors::SessionCursor;
pub use error::{Result, StoreError};
pub use run_events::{FrameCursor, FramePage, RecordedFrame};
pub use store::AgentStore;
pub use threads::{ThreadSummary, TitleSource};
pub use usage::{SessionUsage, TokenDay};
