//! 帧形状在全仓的唯一定义处；判别式 kind 用 snake_case、字段用 camelCase，均由 serde 派生。

use serde::Serialize;
use serde_json::Value;

use poietica_conversation::link::LinkState;

pub const PROMPT_ADMITTED: &str = "prompt_admitted";
pub(crate) const PERMISSION_REQUESTED: &str = "permission_requested";
pub(crate) const PERMISSION_RESOLVED: &str = "permission_resolved";
pub(crate) const RUN_FINISHED: &str = "run_finished";
pub(crate) const RUN_FAILED: &str = "run_failed";

pub(crate) const LINK_CHANGED: &str = "link_changed";

pub(crate) const QUESTIONS_ASKED: &str = "questions_asked";

pub(crate) const QUESTIONS_RESOLVED: &str = "questions_resolved";

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum RunFrame {
    /// 这一轮开始了：问的是什么，以及随它一起送出去的技能。
    ///
    /// 附件不在这帧上：哪句话带了哪些附件由 agent transcript 记（ADR 0050），
    /// 本机再存一份就是第二套对话正文。
    PromptAdmitted {
        admission_id: String,
        prompt: String,
        /// 随这句话挂上的技能名，按用户挑选的顺序。
        skills: Vec<String>,
    },
    /// snapshot 在原子水位上的在飞状态；只用于续接当前轮次。
    SessionRecovered { snapshot: Value },
    /// agent 正卡在一次授权请求上。
    PermissionRequested {
        /// 用来把请求与答复对起来的标识 —— kap 自己签发的 approval_id。
        request_id: String,
        tool_call_id: String,
        title: String,
        /// 被征求同意的那次操作，归一成界面读的三格：toolCallId、title、
        /// rawInput（审批项的 tool_input_display）；其余格子是传输层的事，帧不留。
        tool_call: Value,
    },
    /// 那次授权请求是怎么结束的。
    PermissionResolved {
        request_id: String,
        /// kap 的 decision：approved、rejected 或 cancelled。
        decision: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        scope: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        selected_label: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        feedback: Option<String>,
    },
    /// agent 正卡在一组提问上。
    QuestionsAsked {
        /// kap 签发的号。答复与撤下都认它。
        question_id: String,
        /// 引出这一组题的那次工具调用；kap 说它可以缺席，缺席时是空串。
        tool_call_id: String,
        /// 这一组题，原样。题号与选项号是 server 现编的，答的时候原样交回去。
        questions: Value,
    },
    /// 那一组提问结清了。
    QuestionsResolved {
        question_id: String,
        /// answered、dismissed、cancelled 或 undelivered。
        outcome: String,
        /// 逐题的答复，按问的顺序；只有 answered 时非空。
        answers: Value,
        /// 整组的备注；人没写就是空串。
        note: String,
    },
    /// 这条连接此刻的链路态。它耽误的是这一轮，所以它进这一轮的账。
    LinkChanged { link: LinkState },
    /// 这一轮按 agent 自己的说法结束了。
    RunFinished { stop_reason: String },
    /// 这一轮以失败结束。
    RunFailed { message: String },
}

impl RunFrame {
    #[must_use]
    pub const fn kind(&self) -> &'static str {
        match self {
            Self::PromptAdmitted { .. } => PROMPT_ADMITTED,
            Self::SessionRecovered { .. } => "session_recovered",
            Self::PermissionRequested { .. } => PERMISSION_REQUESTED,
            Self::PermissionResolved { .. } => PERMISSION_RESOLVED,
            Self::QuestionsAsked { .. } => QUESTIONS_ASKED,
            Self::QuestionsResolved { .. } => QUESTIONS_RESOLVED,
            Self::LinkChanged { .. } => LINK_CHANGED,
            Self::RunFinished { .. } => RUN_FINISHED,
            Self::RunFailed { .. } => RUN_FAILED,
        }
    }
}

pub(crate) fn prune(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            fields.retain(|_name, member| {
                if member.is_null() {
                    return false;
                }

                prune(member);

                true
            });
        }
        Value::Array(members) => {
            for member in members.iter_mut() {
                prune(member);
            }
        }
        _ => {}
    }
}
