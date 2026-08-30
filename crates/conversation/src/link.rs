//! 这条连接此刻的链路态。
//!
//! 只说链路的事。「模型半天不说话」是这一轮的事，屏幕上由轮次封条的
//! 秒表说，不从这里冒充一次断线。
//!
//! 判别式与字段名就是线上形状：它作为 [`ConversationEvent::LinkChanged`]
//! 的载荷落账（event.rs），重放一条对话就原样再演一遍。改判别式先改这里。
//!
//! 重连几次、等多久、什么错值得再试 —— 那套策略住在适配环（kap-client
//! 的 link.rs），这里只有状态本身。

use serde::{Deserialize, Serialize};

/// 屏幕上那一格链路态。
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum LinkState {
    /// 正在接回来：第几次、共几次、下一次什么时候、上一次为什么没成。
    /// retry_at 等于此刻表示正在拨号，没有倒计时可读。
    Retrying {
        attempt: u32,
        of: u32,
        retry_at: i64,
        reason: String,
    },
    /// 接回来了，以及这一轮是被什么打断的。
    Recovered { reason: String },
    /// 试到头了，接不回来。这一轮的结局由帧记，链路态只报自己。
    Severed { attempts: u32, reason: String },
}
