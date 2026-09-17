use thiserror::Error;

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
