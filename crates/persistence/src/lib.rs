//! Local index of conversations.
//!
//! 这个 crate 回答的都是同一类问题：这台机器上有过什么。有哪些对话、它们叫
//! 什么、各自握着谁的哪个会话、各自挂着哪些附件、每一轮从什么时候到什么时候，
//! 以及上一次关掉时工作台开着哪几格。对话说过什么不在这里 —— 那份记录属于
//! agent，由 session/load 交还，那是唯一一份不会和别人漂移的历史。轮次的两端、
//! 附件、工作台那一份都是同一类：不是内容，是这台机器上的事实。
//!
//! 附件是第四个问题而不是第一个问题的一部分，理由在 attachments.rs：agent
//! 收到的是用户文件的一份 base64 副本，它没有义务交还，多数 CLI 也确实不
//! 交还。那份字节的主人是这台机器，所以账也记在这台机器上。
//!
//! 也正因为如此，这里没有秘密可保：七列元数据的那份副本，挡不住任何一个能
//! 读到 agent 那份明文全文的人。

mod attachments;
mod connection;
mod disposals;
mod error;
mod migrations;
mod store;
mod threads;
mod turn_spans;
mod usage;
mod workbench;

pub use attachments::ThreadAttachment;
pub use connection::DEFAULT_BUSY_TIMEOUT;
pub use error::{Result, StoreError};
pub use store::AgentStore;
pub use threads::{ThreadSummary, TitleSource};
pub use turn_spans::TurnSpan;
pub use usage::{SessionUsage, TokenDay};
