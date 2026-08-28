use serde::{Deserialize, Serialize};

use crate::category::Category;
use crate::retry::Retryability;

/// 稳定错误码。一个码只对应一个原因；删码等于破坏契约。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Code {
    ContractDecodeFailed,
    CapabilityMissing,
    AgentUnavailable,
    AgentStartFailed,
    TurnRejected,
    DeliveryUnknown,
    PermissionDenied,
    WorkspaceUnavailable,
    LedgerAppendFailed,
    LedgerCorrupted,
    Cancelled,
    Internal,
}

impl Code {
    /// 码表的枚举归码表自己所有：新增码只需要改这一处。
    pub const ALL: &'static [Self] = &[
        Self::ContractDecodeFailed,
        Self::CapabilityMissing,
        Self::AgentUnavailable,
        Self::AgentStartFailed,
        Self::TurnRejected,
        Self::DeliveryUnknown,
        Self::PermissionDenied,
        Self::WorkspaceUnavailable,
        Self::LedgerAppendFailed,
        Self::LedgerCorrupted,
        Self::Cancelled,
        Self::Internal,
    ];

    pub fn category(self) -> Category {
        match self {
            Self::ContractDecodeFailed => Category::Protocol,
            Self::CapabilityMissing | Self::WorkspaceUnavailable => Category::Configuration,
            Self::AgentUnavailable | Self::AgentStartFailed | Self::DeliveryUnknown => {
                Category::Transport
            }
            Self::TurnRejected => Category::Validation,
            Self::PermissionDenied => Category::Permission,
            Self::LedgerAppendFailed => Category::Persistence,
            Self::LedgerCorrupted => Category::Integrity,
            Self::Cancelled => Category::Cancelled,
            Self::Internal => Category::Internal,
        }
    }

    pub fn retryability(self) -> Retryability {
        match self {
            Self::AgentUnavailable | Self::DeliveryUnknown | Self::LedgerAppendFailed => {
                Retryability::AfterDelay
            }
            Self::AgentStartFailed
            | Self::CapabilityMissing
            | Self::PermissionDenied
            | Self::WorkspaceUnavailable => Retryability::AfterUserAction,
            Self::Cancelled
            | Self::ContractDecodeFailed
            | Self::Internal
            | Self::LedgerCorrupted
            | Self::TurnRejected => Retryability::No,
        }
    }

    pub fn message_key(self) -> &'static str {
        match self {
            Self::ContractDecodeFailed => "problem.contractDecodeFailed",
            Self::CapabilityMissing => "problem.capabilityMissing",
            Self::AgentUnavailable => "problem.agentUnavailable",
            Self::AgentStartFailed => "problem.agentStartFailed",
            Self::TurnRejected => "problem.turnRejected",
            Self::DeliveryUnknown => "problem.deliveryUnknown",
            Self::PermissionDenied => "problem.permissionDenied",
            Self::WorkspaceUnavailable => "problem.workspaceUnavailable",
            Self::LedgerAppendFailed => "problem.ledgerAppendFailed",
            Self::LedgerCorrupted => "problem.ledgerCorrupted",
            Self::Cancelled => "problem.cancelled",
            Self::Internal => "problem.internal",
        }
    }
}
