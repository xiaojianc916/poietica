use core::fmt;
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use specta::Type;
use uuid::Uuid;

use crate::category::Category;
use crate::code::Code;
use crate::retry::Retryability;

/// 一次失败的编号：日志、上报、界面引用同一个值。
///
/// v7 带时间前缀且单调，按字符串排序即按发生顺序，不必手写 ULID。
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, Type,
)]
#[serde(transparent)]
pub struct DiagnosticId(Uuid);

impl DiagnosticId {
    pub fn issue() -> Self {
        Self(Uuid::now_v7())
    }
}

impl fmt::Display for DiagnosticId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.0)
    }
}

/// 唯一允许跨越进程与语言边界的错误形状。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    pub code: Code,
    pub category: Category,
    pub retryability: Retryability,
    /// 文案键，不是句子：文案归前端目录。
    pub user_message_key: String,
    pub diagnostic_id: DiagnosticId,
    pub details: BTreeMap<String, String>,
}

impl Problem {
    /// 码是唯一输入：类别、可重试性、文案键都由它推出，边界上不许各自决定。
    pub fn new(code: Code, diagnostic_id: DiagnosticId) -> Self {
        Self {
            category: code.category(),
            retryability: code.retryability(),
            user_message_key: code.message_key().to_owned(),
            code,
            diagnostic_id,
            details: BTreeMap::new(),
        }
    }

    /// 细节一律过脱敏表，凭据不会因为「顺手带上下文」进日志。
    #[must_use]
    pub fn with_detail(mut self, key: &str, value: &str) -> Self {
        self.details.insert(key.to_owned(), redact(key, value));
        self
    }
}

/// 键名里出现这些词的值不再原样外传。
const SENSITIVE: &[&str] = &[
    "authorization",
    "cookie",
    "credential",
    "key",
    "password",
    "secret",
    "token",
];

/// 单条细节的长度上限，按字符截断，避免把半个码点写进账本。
const MAX_CHARS: usize = 256;

fn redact(key: &str, value: &str) -> String {
    let lowered = key.to_ascii_lowercase();

    if SENSITIVE.iter().any(|marker| lowered.contains(marker)) {
        return "[redacted]".to_owned();
    }

    value.chars().take(MAX_CHARS).collect()
}
