use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::identity::{Seq, ThreadId, TurnId};
use crate::link::LinkState;

/// 能到达屏幕的一切，封闭在这一个类型里。两种语言都只从它生成自己的视图。
///
/// 判别式与字段名就是账本上的线上形状：屏幕的方言解析（kap 载荷怎么折成条目）
/// 此刻仍住在 TS 投影里，逐个变体类型化的迁移发生在 translate 层 —— 在那之前，
/// 线上原文经 [`ConversationEvent::KapEvent`] 原样过账，重放一条对话与看着它
/// 发生一字不差。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ConversationEvent {
    /// 领域签发：这一轮被准入（先于任何投递；幂等键 = turn id）。
    TurnAdmitted { turn: TurnId },
    /// 这一轮开始了：问的是什么，以及随它一起送出去的图片与技能。
    ///
    /// `admission_id` 是本机签发的 durable admission identity —— 它同时是投递的
    /// 幂等键（ports 的 PromptDelivery），所以屏幕上那条用户消息与账本上的准入
    /// 行同号。可选说的是日志：这一格加进来之前录下的帧没有它，历史改不了。
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
    /// kap server 推来的一帧会话事件，线上原文原样过账。
    ///
    /// 这一层一个字段都不认识 —— 认识它的是投影它的那一层。
    KapEvent { payload: Value },
    /// agent 正卡在一次授权请求上。
    PermissionRequested {
        request_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        tool_call_id: Option<String>,
        title: String,
        /// 被征求同意的那次操作，归一成界面读的三格。
        tool_call: Value,
    },
    /// 那次授权请求是怎么结束的。
    PermissionResolved {
        request_id: String,
        decision: String,
        /// 「这条会话都照此办理」时是 session；只此一次就不出现。
        #[serde(skip_serializing_if = "Option::is_none")]
        scope: Option<String>,
        /// 计划复审所选方案的协议 label。
        #[serde(skip_serializing_if = "Option::is_none")]
        selected_label: Option<String>,
        /// 给 agent 的可选留言。
        #[serde(skip_serializing_if = "Option::is_none")]
        feedback: Option<String>,
    },
    /// agent 正卡在一组提问上。
    QuestionsAsked {
        question_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        tool_call_id: Option<String>,
        questions: Value,
    },
    /// 那一组提问结清了。
    QuestionsResolved {
        question_id: String,
        outcome: String,
        answers: Value,
        note: String,
    },
    /// 这条连接此刻的链路态。它耽误的是这一轮，所以它进这一轮的账。
    LinkChanged { link: LinkState },
    /// 快照恢复：resync 之后这一轮从原子水位续接。机制帧 —— 投影不落条目，
    /// 落账是为了重放时说得清这段经过从哪儿接上的。
    SessionRecovered { snapshot: Value },
    /// 这一轮按 agent 自己的说法结束了。
    RunFinished {
        #[serde(skip_serializing_if = "Option::is_none")]
        turn: Option<TurnId>,
        stop_reason: String,
    },
    /// 这一轮以失败结束 —— 本机的说法（agent 那侧没有对应的一帧）。
    RunFailed {
        #[serde(skip_serializing_if = "Option::is_none")]
        turn: Option<TurnId>,
        message: String,
    },
    /// pin 住的契约还不认识的事件。留着，重放才忠实，缺口才可计数。
    /// 字段不能叫 kind：与 serde 内部 tag 撞名。
    UnsupportedExternalEvent { raw_kind: String },
}

impl ConversationEvent {
    /// 这一帧属于哪一轮。缺席不是兜底：有些帧（链路态）不属于任何一轮。
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
            Self::KapEvent { .. }
            | Self::SessionRecovered { .. }
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

    /// 账本里的 kind 列。改这里等于改已落盘数据的读法。
    pub fn kind(&self) -> &'static str {
        match self {
            Self::TurnAdmitted { .. } => "turn_admitted",
            Self::PromptAdmitted { .. } => "prompt_admitted",
            Self::KapEvent { .. } => "kap_event",
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

/// 一帧，已经落了账本位置，可以交出去。
///
/// `session_id` 是产生它的那台 kap 会话：一条连接同时开着多条会话，屏幕按它
/// 把帧路由到对话。`at` 与 `seq` 由账本在追加时发给 —— 写路径不自报时间与位置。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventEnvelope {
    pub thread: ThreadId,
    pub seq: Seq,
    /// 记下它的时刻，epoch 毫秒；账本的时钟发的。
    pub at: i64,
    pub session_id: String,
    pub event: ConversationEvent,
}
