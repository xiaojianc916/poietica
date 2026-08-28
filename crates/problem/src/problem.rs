use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::category::Category;
use crate::code::Code;
use crate::diagnostic::DiagnosticId;
use crate::redaction::redact;
use crate::retry::Retryability;

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
