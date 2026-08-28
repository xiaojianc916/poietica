use serde::{Deserialize, Serialize};

use crate::turn::state_machine::TurnSignal;

/// 取消由谁发起。取消状态只存在 TurnState 里，这里不另存一份。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CancelOrigin {
    User,
    Shutdown,
    Superseded,
}

impl CancelOrigin {
    pub fn signal(self) -> TurnSignal {
        TurnSignal::CancelRequested { origin: self }
    }
}
