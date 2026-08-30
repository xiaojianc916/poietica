use serde::{Deserialize, Serialize};

use crate::identity::{ThreadId, TurnId};

/// 随一句话带上的一个附件，冻结的是引用不是字节：字节按内容摘要落在盘上，
/// 适配层在投递时把它再成形为协议载荷。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentRef {
    /// 小写十六进制 SHA-256，与附件账、资产协议地址同一名。
    pub hash: String,
    /// 文件头嗅出的内容类型，图片与文本的分界由它判。
    pub mime: String,
}

/// 随一句话挂上的一个技能，按用户挑选的顺序冻结。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSpec {
    pub name: String,
    pub args: Option<String>,
}

/// 被冻结的用户意图。turn 是幂等键，所以同一轮的重发是同一行。
///
/// 冻结在准入时完成：之后无论重试多少次，投递的都是同一句话、同一批附件、
/// 同一份技能清单 —— 重放与当时不可能不一样。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Admission {
    pub thread: ThreadId,
    pub turn: TurnId,
    pub prompt: String,
    pub model: String,
    pub attachments: Vec<AttachmentRef>,
    pub skills: Vec<SkillSpec>,
    pub submitted_at_unix_millis: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmissionDecision {
    Admitted,
    AlreadyAdmitted,
}
