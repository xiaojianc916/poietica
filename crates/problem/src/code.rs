use serde::{Deserialize, Serialize};
use specta::Type;

use crate::category::Category;
use crate::retry::Retryability;

/// 稳定错误码。一个码只对应一个原因；删码等于破坏契约。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
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
    RequestInvalid,
    ResourceMissing,
    FileUnavailable,
    SettingsUnavailable,
    AssetRejected,
    PluginRejected,
    AgentRejected,
    GitRejected,
    HostFailed,
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
        Self::RequestInvalid,
        Self::ResourceMissing,
        Self::FileUnavailable,
        Self::SettingsUnavailable,
        Self::AssetRejected,
        Self::PluginRejected,
        Self::AgentRejected,
        Self::GitRejected,
        Self::HostFailed,
    ];

    /// 同类的码并成一条臂：一处一类，加码时认自己那一类。
    pub fn category(self) -> Category {
        match self {
            Self::RequestInvalid
            | Self::ResourceMissing
            | Self::AssetRejected
            | Self::PluginRejected
            | Self::AgentRejected
            | Self::GitRejected
            | Self::TurnRejected => Category::Validation,
            Self::FileUnavailable | Self::SettingsUnavailable | Self::LedgerAppendFailed => {
                Category::Persistence
            }
            Self::HostFailed | Self::Internal => Category::Internal,
            Self::ContractDecodeFailed => Category::Protocol,
            Self::CapabilityMissing | Self::WorkspaceUnavailable => Category::Configuration,
            Self::AgentUnavailable | Self::AgentStartFailed | Self::DeliveryUnknown => {
                Category::Transport
            }
            Self::PermissionDenied => Category::Permission,
            Self::LedgerCorrupted => Category::Integrity,
            Self::Cancelled => Category::Cancelled,
        }
    }

    pub fn retryability(self) -> Retryability {
        match self {
            Self::RequestInvalid
            | Self::ResourceMissing
            | Self::HostFailed
            | Self::TurnRejected
            | Self::Cancelled
            | Self::ContractDecodeFailed
            | Self::Internal
            | Self::LedgerCorrupted => Retryability::No,
            Self::FileUnavailable
            | Self::SettingsUnavailable
            | Self::AgentUnavailable
            | Self::DeliveryUnknown
            | Self::LedgerAppendFailed => Retryability::AfterDelay,
            Self::AssetRejected
            | Self::PluginRejected
            | Self::AgentRejected
            | Self::GitRejected
            | Self::AgentStartFailed
            | Self::CapabilityMissing
            | Self::PermissionDenied
            | Self::WorkspaceUnavailable => Retryability::AfterUserAction,
        }
    }

    pub fn message_key(self) -> &'static str {
        match self {
            Self::RequestInvalid => "problem.requestInvalid",
            Self::ResourceMissing => "problem.resourceMissing",
            Self::FileUnavailable => "problem.fileUnavailable",
            Self::SettingsUnavailable => "problem.settingsUnavailable",
            Self::AssetRejected => "problem.assetRejected",
            Self::PluginRejected => "problem.pluginRejected",
            Self::AgentRejected => "problem.agentRejected",
            Self::GitRejected => "problem.gitRejected",
            Self::HostFailed => "problem.hostFailed",
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
