use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::identity::{Seq, ThreadId, TurnId};
use crate::link::LinkState;

/// 能到达屏幕的本机事实（准入、审批、提问、链路、轮终）；kap 的语义事件由官方 transcript 通道直供，不走这里。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ConversationEvent {
    TurnAdmitted {
        turn: TurnId,
    },
    /// admission_id 同时是投递的幂等键（ports 的 PromptDelivery）：屏幕上那条用户消息与账本准入行同号；可缺省，加该字段之前的旧帧没有它。
    PromptAdmitted {
        #[serde(rename = "admissionId")]
        admission_id: TurnId,
        #[serde(skip_serializing_if = "Option::is_none")]
        prompt: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        images: Option<Vec<String>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        skills: Option<Vec<String>>,
    },
    PermissionRequested {
        request_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        tool_call_id: Option<String>,
        title: String,
        tool_call: Value,
    },
    PermissionResolved {
        request_id: String,
        decision: String,
        /// 「这条会话都照此办理」时是 "session"；只此一次则缺席。
        #[serde(skip_serializing_if = "Option::is_none")]
        scope: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        selected_label: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        feedback: Option<String>,
    },
    QuestionsAsked {
        question_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        tool_call_id: Option<String>,
        questions: Value,
    },
    QuestionsResolved {
        question_id: String,
        outcome: String,
        answers: Value,
        note: String,
    },
    LinkChanged {
        link: LinkState,
    },
    SessionRecovered {
        snapshot: Value,
    },
    RunFinished {
        #[serde(skip_serializing_if = "Option::is_none")]
        turn: Option<TurnId>,
        stop_reason: String,
    },
    /// 本机的说法：agent 那侧的协议没有对应的失败帧。
    RunFailed {
        #[serde(skip_serializing_if = "Option::is_none")]
        turn: Option<TurnId>,
        message: String,
    },
    /// 字段不能叫 kind：与 serde 的内部 tag 撞名。
    UnsupportedExternalEvent {
        raw_kind: String,
    },
}

impl ConversationEvent {
    pub fn turn(&self) -> Option<&TurnId> {
        match self {
            Self::TurnAdmitted { turn }
            | Self::PromptAdmitted {
                admission_id: turn, ..
            }
            | Self::RunFinished {
                turn: Some(turn), ..
            }
            | Self::RunFailed {
                turn: Some(turn), ..
            } => Some(turn),
            Self::SessionRecovered { .. }
            | Self::PermissionRequested { .. }
            | Self::PermissionResolved { .. }
            | Self::QuestionsAsked { .. }
            | Self::QuestionsResolved { .. }
            | Self::LinkChanged { .. }
            | Self::RunFinished { turn: None, .. }
            | Self::RunFailed { turn: None, .. }
            | Self::UnsupportedExternalEvent { .. } => None,
        }
    }

    /// 改返回值等于改已落盘数据的读法。
    pub fn kind(&self) -> &'static str {
        match self {
            Self::TurnAdmitted { .. } => "turn_admitted",
            Self::PromptAdmitted { .. } => "prompt_admitted",
            Self::SessionRecovered { .. } => "session_recovered",
            Self::PermissionRequested { .. } => "permission_requested",
            Self::PermissionResolved { .. } => "permission_resolved",
            Self::QuestionsAsked { .. } => "questions_asked",
            Self::QuestionsResolved { .. } => "questions_resolved",
            Self::LinkChanged { .. } => "link_changed",
            Self::RunFinished { .. } => "run_finished",
            Self::RunFailed { .. } => "run_failed",
            Self::UnsupportedExternalEvent { .. } => "unsupported_external_event",
        }
    }
}

/// 一帧，已落账本位置。at 与 seq 由账本追加时发给，写路径不自报时间与位置；session_id 供屏幕按会话路由。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventEnvelope {
    pub thread: ThreadId,
    pub seq: Seq,
    pub at: i64,
    pub session_id: String,
    pub event: ConversationEvent,
}
