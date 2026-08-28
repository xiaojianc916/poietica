use serde::{Deserialize, Serialize};

use crate::identity::{ThreadId, TurnId};

/// 被冻结的用户意图。turn 是幂等键，所以同一轮的重发是同一行。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Admission {
    pub thread: ThreadId,
    pub turn: TurnId,
    pub prompt: String,
    pub model: String,
    pub attachments: Vec<String>,
    pub submitted_at_unix_millis: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmissionDecision {
    Admitted,
    AlreadyAdmitted,
}
