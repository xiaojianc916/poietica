use std::collections::HashMap;

use serde_json::{Value, json};

/// What the client will answer a permission request with.
///
/// kap 的审批不带选项清单（approvalRequestSchema 只有 tool_name / action /
/// tool_input_display），所以答复的词汇表由这一侧按协议的答复面合成 ——
/// 三个选项正好盖住 approvalResponseSchema 的 decision × scope。
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum Decision {
    /// Approve, by selecting one of the approval options.
    Allow(String),
    /// Refuse, by selecting the rejection option.
    Reject(String),
    /// Refuse without selecting an option, which the protocol reserves for a
    /// turn that ended before anyone answered.
    Cancel,
}

impl Decision {
    /// The option that was chosen, when one was.
    #[must_use]
    pub fn option_id(&self) -> Option<&str> {
        match self {
            Self::Allow(option_id) | Self::Reject(option_id) => Some(option_id),
            Self::Cancel => None,
        }
    }
}

/// 批准这一次。
pub const APPROVE: &str = "approve";
/// 批准，并且在这条会话上记住（kap 的 scope: "session"）。
pub const APPROVE_SESSION: &str = "approve_session";
/// 拒绝。
pub const REJECT: &str = "reject";

/// 选项上的字与上游自己的审批按钮逐字相同（上游 packages/acp-adapter
/// /src/approval.ts 的 CANONICAL_OPTIONS：Approve once / Approve for this
/// session / Reject），桌面的选项文案表（agent-catalog 的 OPTION_LABELS）
/// 翻的正是这三条。kind 沿用界面权限卡片既有的风格词汇表。
pub fn kap_options() -> Value {
    json!([
        { "optionId": APPROVE, "name": "Approve once", "kind": "allow_once" },
        { "optionId": APPROVE_SESSION, "name": "Approve for this session", "kind": "allow_always" },
        { "optionId": REJECT, "name": "Reject", "kind": "reject_once" },
    ])
}

/// The answers the user is allowed to give, keyed by option identifier.
///
/// 选项集是固定的三条，所以合法答复表也是固定的：一个不在表里的选项号
/// 就是没人提供过的选项 —— 这正是界面来的答案先过桌子再上线的判据。
pub fn kap_answers() -> HashMap<String, Decision> {
    HashMap::from([
        (APPROVE.to_owned(), Decision::Allow(APPROVE.to_owned())),
        (
            APPROVE_SESSION.to_owned(),
            Decision::Allow(APPROVE_SESSION.to_owned()),
        ),
        (REJECT.to_owned(), Decision::Reject(REJECT.to_owned())),
    ])
}

/// 一个答复在 kap 线上的形状（approvalResponseSchema：decision 必填，
/// scope 只在「这条会话上记住」时出现）。
#[must_use]
pub fn kap_response(decision: &Decision) -> (&'static str, Option<&'static str>) {
    match decision {
        Decision::Allow(option_id) if option_id.as_str() == APPROVE_SESSION => {
            ("approved", Some("session"))
        }
        Decision::Allow(_) => ("approved", None),
        Decision::Reject(_) => ("rejected", None),
        Decision::Cancel => ("cancelled", None),
    }
}
