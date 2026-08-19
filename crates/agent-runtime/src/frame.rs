//! 一次运行的事件契约。
//!
//! 这里是帧形状在整个仓库里的唯一定义处。它是一个强类型 enum 而不是一串
//! json! 字面量，所以字段名拼错是编译错误，而不是一个要靠界面侧第二份
//! schema 在运行期抓出来的问题。
//!
//! 判别式与字段名由 serde 派生：kind 用 snake_case，字段用界面读的
//! camelCase。线上形状就是契约：kap 的事件帧载荷原样进 KapEvent，
//! 这一层一个字段都不认识，认识它的是投影它的那一层。

use serde::Serialize;
use serde_json::Value;

/// 一轮的第一帧。
pub const RUN_STARTED: &str = "run_started";
/// kap server 推来的一帧会话事件。
pub const KAP_EVENT: &str = "kap_event";
/// agent 正卡在一次授权请求上。
pub const PERMISSION_REQUESTED: &str = "permission_requested";
/// 那次授权请求得到的答复。
pub const PERMISSION_RESOLVED: &str = "permission_resolved";
/// 这一轮按 agent 自己的说法结束了。
pub const RUN_FINISHED: &str = "run_finished";
/// 这一轮以失败结束。
pub const RUN_FAILED: &str = "run_failed";

/// 这一组题问出去了，agent 正卡在它上面。
pub const QUESTIONS_ASKED: &str = "questions_asked";

/// 那一组题结清了。
pub const QUESTIONS_RESOLVED: &str = "questions_resolved";

/// 一次运行里可能发生的六种事。
///
/// KapEvent 承载 kap 的事件原文；其余五种是协议不建模、而客户端必须记住的
/// 事实。每一种都带 seq 与 at（见 RecordedEvent），所以重放是确定的。
#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum RunFrame {
    /// 这一轮开始了：问的是什么，以及随它送出去的图片。
    RunStarted {
        /// 人说的那句话，按记录时的原文。
        prompt: String,
        /// 随这句话送出去的图片，按用户挑选的顺序，本机资产协议地址。
        ///
        /// 记地址而不是字节：字节按内容摘要落在磁盘上，而地址跨重启仍然指得回
        /// 同一张图（交付令牌是对话号，见桌面侧 deliver_attachments）。图不是
        /// agent 发来的，但它属于人说的那一句话 —— 所以它的家在这一帧里，不在
        /// 一本要靠数轮次去对齐的第二本账上。
        images: Vec<String>,
    },
    /// kap server 推来的一帧会话事件。
    KapEvent {
        /// 事件帧的载荷，原始 JSON。信封的 type 就是它自己的 type。
        payload: Value,
    },
    /// agent 正卡在一次授权请求上。
    PermissionRequested {
        /// 用来把请求与答复对起来的标识 —— kap 自己签发的 approval_id。
        request_id: String,
        /// 被问到的那次工具调用。
        tool_call_id: String,
        /// 界面必须显示的标题。
        title: String,
        /// 被征求同意的那次操作，归一成界面读的三格：toolCallId、title、
        /// rawInput（审批项的 tool_input_display）。审批项的其余格子是传输
        /// 层的事，帧不留。
        tool_call: Value,
        /// 这一侧按 kap 的答复词汇表合成的选项（见 permission.rs）。
        options: Value,
    },
    /// 那次授权请求是怎么结束的。
    PermissionResolved {
        /// 被结清的那个请求。
        request_id: String,
        /// 选中的选项；取消时为空。
        option_id: String,
        /// selected 或 cancelled。
        outcome: String,
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
        /// 被结清的那一组。
        question_id: String,
        /// answered、dismissed、cancelled 或 undelivered。
        outcome: String,
        /// 逐题的答复，按问的顺序；只有 answered 时非空。
        answers: Value,
        /// 整组的备注；人没写就是空串。
        note: String,
    },
    /// 这一轮按 agent 自己的说法结束了。
    RunFinished {
        /// agent 报的停止原因。
        stop_reason: String,
    },
    /// 这一轮以失败结束。
    RunFailed {
        /// 我们的说法。
        message: String,
    },
}

impl RunFrame {
    /// 这一帧在日志里记作哪一类。返回的就是 wire 上的判别式。
    #[must_use]
    pub const fn kind(&self) -> &'static str {
        match self {
            Self::RunStarted { .. } => RUN_STARTED,
            Self::KapEvent { .. } => KAP_EVENT,
            Self::PermissionRequested { .. } => PERMISSION_REQUESTED,
            Self::PermissionResolved { .. } => PERMISSION_RESOLVED,
            Self::QuestionsAsked { .. } => QUESTIONS_ASKED,
            Self::QuestionsResolved { .. } => QUESTIONS_RESOLVED,
            Self::RunFinished { .. } => RUN_FINISHED,
            Self::RunFailed { .. } => RUN_FAILED,
        }
    }
}

/// 删掉 null 成员。它们是 Option::None 的产物，对界面而言与缺席同义。
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

/// 把 kap server 推来的一条事件载荷做成一帧。
///
/// 实时的一轮与装载期的重播都走这里，所以两边的帧一模一样 —— 一条对话重开
/// 之后，与当时看着它发生，不可能有出入。驱动线与集成测试都从这里成帧，
/// 不另造第二份。
pub fn kap_event(payload: Value) -> RunFrame {
    RunFrame::KapEvent { payload }
}
