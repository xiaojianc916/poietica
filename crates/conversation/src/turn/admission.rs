use serde::{Deserialize, Serialize};

use crate::identity::{ThreadId, TurnId};

/// 随一句话带上的一个附件，冻结的是引用不是字节：字节按内容摘要落在盘上，
/// 适配层在投递时把它再成形为协议载荷。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentRef {
    /// 小写十六进制 SHA-256，与附件账、资产协议地址同一名。
    pub hash: String,
    /// 文件头嗅出的内容类型，图片与通用文件的分界由它判。
    pub mime: String,
    /// 用户看到的文件名；通用文件卡片与 file part 都用它，字节本身不进正文。
    pub name: String,
    /// 字节数；文件卡片与 file part 的 size 字段用它。
    pub size: i64,
}

/// 随一句话挂上的一个技能，按用户挑选的顺序冻结。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSpec {
    pub name: String,
    pub args: Option<String>,
}

/// 这句话怎么交给 agent —— omp 的三层插话，打断程度递减。
///
/// 领域只认这个形状，不认识 omp 的方法名；把它翻成 `session.steer` / `session.followUp`
/// 是适配层的事（ADR 0001 的分层）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeliverAs {
    /// 开一轮。回执是官方 prompt id。
    #[default]
    Turn,
    /// 插进正在跑的那一轮：在工具批次之间被模型看到。
    Steer,
    /// 不打断：这一轮跑完后自动作为下一轮输入。
    FollowUp,
}

impl DeliverAs {
    /// 插话（不开轮）与正常发送的分野。队列归 agent，本机只记这一句话出去了。
    #[must_use]
    pub const fn is_interjection(self) -> bool {
        !matches!(self, Self::Turn)
    }

    /// 账本里的 deliver_as 列；改这里等于改已落盘数据的读法。
    #[must_use]
    pub const fn as_stored(self) -> &'static str {
        match self {
            Self::Turn => "turn",
            Self::Steer => "steer",
            Self::FollowUp => "followUp",
        }
    }

    /// 账本是未发布的形状，所以只有这三种写法。认不出来的值只可能来自手改的库：
    /// 按 `Turn` 走 —— 那句话会正常开一轮，而不是被静默丢掉。
    #[must_use]
    pub fn from_stored(value: &str) -> Self {
        match value {
            "steer" => Self::Steer,
            "followUp" => Self::FollowUp,
            _ => Self::Turn,
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        reason = "a test proves itself by panicking, so a broken mapping must fail the test"
    )]

    use super::DeliverAs;

    /// 三档必须逐字往返：改 `as_stored` 等于改已落盘数据的读法。
    #[test]
    fn the_layers_round_trip() {
        for layer in [DeliverAs::Turn, DeliverAs::Steer, DeliverAs::FollowUp] {
            assert_eq!(DeliverAs::from_stored(layer.as_stored()), layer);
        }
    }

    /// ADR 0034 那一段已经收口：aside 不再是本仓的一档，认不出的写法按开一轮走。
    #[test]
    fn an_unknown_layer_replays_as_a_turn() {
        assert_eq!(DeliverAs::from_stored(""), DeliverAs::Turn);
        assert_eq!(DeliverAs::from_stored("aside"), DeliverAs::Turn);
        assert_eq!(DeliverAs::from_stored("nonsense"), DeliverAs::Turn);
    }
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
    /// 这一句走哪一层。
    pub deliver_as: DeliverAs,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmissionDecision {
    Admitted,
    AlreadyAdmitted,
}
