use core::fmt;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// 一次失败的编号：日志、上报、界面引用同一个值。
///
/// v7 带时间前缀且单调，按字符串排序即按发生顺序，不必手写 ULID。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DiagnosticId(Uuid);

impl DiagnosticId {
    pub fn issue() -> Self {
        Self(Uuid::now_v7())
    }

    pub fn from_uuid(value: Uuid) -> Self {
        Self(value)
    }

    pub fn as_uuid(self) -> Uuid {
        self.0
    }
}

impl fmt::Display for DiagnosticId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.0)
    }
}
