use serde::{Deserialize, Serialize};

use crate::error::TurnError;
use crate::turn::cancellation::CancelOrigin;

/// 一轮的终局。取消是终局的一种，不是异常。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TurnCompletion {
    Completed,
    Cancelled,
    Failed { reason: String },
}

/// 轮次生命周期的唯一真相，不在别处再存一份。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum TurnState {
    Admitted,
    Delivering,
    Streaming,
    AwaitingInteraction,
    Cancelling { origin: CancelOrigin },
    Finished { completion: TurnCompletion },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TurnSignal {
    DeliveryStarted,
    DeliveryAccepted,
    InteractionRequested,
    InteractionResolved,
    CancelRequested { origin: CancelOrigin },
    Finished { completion: TurnCompletion },
}

impl TurnState {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Admitted => "admitted",
            Self::Delivering => "delivering",
            Self::Streaming => "streaming",
            Self::AwaitingInteraction => "awaitingInteraction",
            Self::Cancelling { .. } => "cancelling",
            Self::Finished { .. } => "finished",
        }
    }

    pub fn is_finished(&self) -> bool {
        matches!(self, Self::Finished { .. })
    }

    /// 只有信号能改状态；不合法的转移报错，不默默否定。
    pub fn apply(&self, signal: &TurnSignal) -> Result<Self, TurnError> {
        let illegal = |name: &str| TurnError::IllegalTransition {
            state: self.label().to_owned(),
            signal: name.to_owned(),
        };

        match (self, signal) {
            (Self::Delivering, TurnSignal::DeliveryAccepted)
            | (Self::AwaitingInteraction, TurnSignal::InteractionResolved) => Ok(Self::Streaming),
            (Self::Streaming, TurnSignal::InteractionRequested) => Ok(Self::AwaitingInteraction),
            (
                Self::Admitted | Self::Delivering | Self::Streaming | Self::AwaitingInteraction,
                TurnSignal::CancelRequested { origin },
            ) => Ok(Self::Cancelling { origin: *origin }),
            // 取消一旦请求，终局归一为 Cancelled，避免两个终局互相矛盾。
            (Self::Cancelling { .. }, TurnSignal::Finished { .. }) => Ok(Self::Finished {
                completion: TurnCompletion::Cancelled,
            }),
            (
                Self::Admitted | Self::Delivering | Self::Streaming | Self::AwaitingInteraction,
                TurnSignal::Finished { completion },
            ) => Ok(Self::Finished {
                completion: completion.clone(),
            }),
            (_, TurnSignal::DeliveryStarted) => Err(illegal("deliveryStarted")),
            (_, TurnSignal::DeliveryAccepted) => Err(illegal("deliveryAccepted")),
            (_, TurnSignal::InteractionRequested) => Err(illegal("interactionRequested")),
            (_, TurnSignal::InteractionResolved) => Err(illegal("interactionResolved")),
            (_, TurnSignal::CancelRequested { .. }) => Err(illegal("cancelRequested")),
            (_, TurnSignal::Finished { .. }) => Err(illegal("finished")),
        }
    }
}
