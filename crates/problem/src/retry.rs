use serde::{Deserialize, Serialize};

/// 能不能再来一次，以及由谁发起。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Retryability {
    No,
    AfterDelay,
    AfterUserAction,
}
