use thiserror::Error;

use crate::identity::{ThreadId, TurnId};

#[derive(Debug, Error, PartialEq, Eq)]
pub enum TurnError {
    #[error("信号 {signal} 在 {state} 状态下不合法")]
    IllegalTransition { state: String, signal: String },
    #[error("投递结果 {outcome} 在 {state} 状态下不合法")]
    IllegalDelivery { state: String, outcome: String },
}

/// 账本不可用。领域不修它，原样交上去。
#[derive(Debug, Error, PartialEq, Eq)]
#[error("账本不可用：{reason}")]
pub struct LedgerUnavailable {
    pub reason: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
#[error("agent 网关拒绝了这一轮：{reason}")]
pub struct GatewayFailure {
    pub reason: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum DomainFailure {
    #[error(transparent)]
    Ledger(#[from] LedgerUnavailable),
    #[error(transparent)]
    Turn(#[from] TurnError),
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum InvariantViolation {
    #[error("对话 {thread} 的事件 {seq} 没有排在 {previous} 之后")]
    SeqNotMonotonic {
        thread: ThreadId,
        seq: u64,
        previous: u64,
    },
    #[error("轮次 {turn} 在结束之后还产出了事件")]
    EventAfterFinish { turn: TurnId },
}
