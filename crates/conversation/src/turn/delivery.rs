use serde::{Deserialize, Serialize};

use crate::error::TurnError;

/// 投递的记账状态。unknown 是合法状态：发出去但没等到裁决，重启后必须能追问。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeliveryState {
    Pending,
    Sent,
    Accepted,
    Unknown,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeliveryOutcome {
    Sent,
    Accepted,
    Indeterminate,
    Rejected,
}

impl DeliveryState {
    /// 账本里的 state 列；改这里等于改已落盘数据的读法。
    pub fn as_stored(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Sent => "sent",
            Self::Accepted => "accepted",
            Self::Unknown => "unknown",
            Self::Failed => "failed",
        }
    }

    pub fn from_stored(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(Self::Pending),
            "sent" => Some(Self::Sent),
            "accepted" => Some(Self::Accepted),
            "unknown" => Some(Self::Unknown),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }

    pub fn is_settled(self) -> bool {
        matches!(self, Self::Accepted | Self::Failed)
    }

    pub fn apply(self, outcome: DeliveryOutcome) -> Result<Self, TurnError> {
        let illegal = |name: &str| TurnError::IllegalDelivery {
            state: self.as_stored().to_owned(),
            outcome: name.to_owned(),
        };

        match (self, outcome) {
            (Self::Pending, DeliveryOutcome::Sent) => Ok(Self::Sent),
            (Self::Pending | Self::Sent | Self::Unknown, DeliveryOutcome::Accepted) => {
                Ok(Self::Accepted)
            }
            (Self::Pending | Self::Sent | Self::Unknown, DeliveryOutcome::Indeterminate) => {
                Ok(Self::Unknown)
            }
            (Self::Pending | Self::Sent | Self::Unknown, DeliveryOutcome::Rejected) => {
                Ok(Self::Failed)
            }
            (_, DeliveryOutcome::Sent) => Err(illegal("sent")),
            (_, DeliveryOutcome::Accepted) => Err(illegal("accepted")),
            (_, DeliveryOutcome::Indeterminate) => Err(illegal("indeterminate")),
            (_, DeliveryOutcome::Rejected) => Err(illegal("rejected")),
        }
    }
}
