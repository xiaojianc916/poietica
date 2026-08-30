//! 会话领域：准入、轮次生命周期、投递记账，以及实时流与冷重放共用的那一个投影。
//!
//! 没有 IO、没有运行时、没有协议类型。领域需要外界的东西一律是 ports 里的 trait。

pub mod command;
pub mod error;
pub mod event;
pub mod identity;
pub mod invariants;
pub mod link;
pub mod ports;
pub mod projection;
pub mod turn;
