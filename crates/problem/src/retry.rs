use serde::{Deserialize, Serialize};
use specta::Type;

/// 能不能再来一次，以及由谁发起。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Retryability {
    No,
    AfterDelay,
    AfterUserAction,
}
