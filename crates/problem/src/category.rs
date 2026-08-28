use serde::{Deserialize, Serialize};

/// 谁该负责。封闭九类，边界上不许另起分类。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Category {
    Validation,
    Configuration,
    Permission,
    Transport,
    Protocol,
    Persistence,
    Integrity,
    Cancelled,
    Internal,
}
