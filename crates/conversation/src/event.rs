use serde::{Deserialize, Serialize};

use crate::identity::{Seq, ThreadId, TurnId};
use crate::interaction::{InteractionAnswer, InteractionId, InteractionRequest};
use crate::tool_call::{ToolCallId, ToolOutcome};
use crate::turn::state_machine::TurnCompletion;

/// 能到达屏幕的一切，封闭在这一个类型里。两种语言都只从它生成自己的视图。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ConversationEvent {
    TurnAdmitted {
        turn: TurnId,
    },
    AssistantText {
        turn: TurnId,
        text: String,
    },
    Reasoning {
        turn: TurnId,
        text: String,
    },
    ToolCallStarted {
        turn: TurnId,
        call: ToolCallId,
        name: String,
    },
    ToolCallFinished {
        turn: TurnId,
        call: ToolCallId,
        outcome: ToolOutcome,
    },
    InteractionRequested {
        turn: TurnId,
        request: InteractionRequest,
    },
    InteractionResolved {
        turn: TurnId,
        interaction: InteractionId,
        answer: InteractionAnswer,
    },
    UsageReported {
        turn: TurnId,
        input_tokens: u64,
        output_tokens: u64,
    },
    TurnFinished {
        turn: TurnId,
        completion: TurnCompletion,
    },
    /// pin 住的契约还不认识的事件。留着，重放才忠实，缺口才可计数。
    /// 字段不能叫 kind：与 serde 内部 tag 撞名。
    UnsupportedExternalEvent {
        raw_kind: String,
    },
}

impl ConversationEvent {
    pub fn turn(&self) -> Option<&TurnId> {
        match self {
            Self::TurnAdmitted { turn }
            | Self::AssistantText { turn, .. }
            | Self::Reasoning { turn, .. }
            | Self::ToolCallStarted { turn, .. }
            | Self::ToolCallFinished { turn, .. }
            | Self::InteractionRequested { turn, .. }
            | Self::InteractionResolved { turn, .. }
            | Self::UsageReported { turn, .. }
            | Self::TurnFinished { turn, .. } => Some(turn),
            Self::UnsupportedExternalEvent { .. } => None,
        }
    }

    /// 账本里的 kind 列。改这里等于改已落盘数据的读法。
    pub fn kind(&self) -> &'static str {
        match self {
            Self::TurnAdmitted { .. } => "turnAdmitted",
            Self::AssistantText { .. } => "assistantText",
            Self::Reasoning { .. } => "reasoning",
            Self::ToolCallStarted { .. } => "toolCallStarted",
            Self::ToolCallFinished { .. } => "toolCallFinished",
            Self::InteractionRequested { .. } => "interactionRequested",
            Self::InteractionResolved { .. } => "interactionResolved",
            Self::UsageReported { .. } => "usageReported",
            Self::TurnFinished { .. } => "turnFinished",
            Self::UnsupportedExternalEvent { .. } => "unsupportedExternalEvent",
        }
    }
}

/// 事件加上账本给它的位置。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventEnvelope {
    pub thread: ThreadId,
    pub seq: Seq,
    pub event: ConversationEvent,
}
