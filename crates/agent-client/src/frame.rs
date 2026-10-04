//! 帧形状在全仓的唯一定义处；判别式 kind 用 snake_case、字段用 camelCase，均由 serde 派生。

use serde::Serialize;
use serde_json::Value;

use poietica_conversation::link::LinkState;

/*
 * 判别式字面量由 serde 的 `tag = "kind"` 派生，不再手写一份 —— 曾有一张 kind() 表
 * 制造了第二个事实，已删。这一个常量例外，因为有外部读者（conversation-runtime 按它认准入帧）。
 */
pub const PROMPT_ADMITTED: &str = "prompt_admitted";

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum RunFrame {
    /// 这一轮开始了：问的是什么，以及随它一起送出去的技能。
    ///
    /// 附件不在这帧上：哪句话带了哪些附件由 agent transcript 记（ADR 0014），
    /// 本机再存一份就是第二套对话正文。
    PromptAdmitted {
        admission_id: String,
        prompt: String,
        /// 随这句话挂上的技能名，按用户挑选的顺序。
        skills: Vec<String>,
    },
    /// agent 正卡在一次授权请求上。
    PermissionRequested {
        /// 用来把请求与答复对起来的标识 —— 桥那次对话框签发的号。
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
        /// 产品的 decision：approved、rejected 或 cancelled。
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
        /// 这一次提问的号：上游那次对话框的 requestId。答复与撤下都认它。
        question_id: String,
        /// 引出这一组题的那次工具调用；omp 的 ask 载荷里没有调用号，据实记 'ask'。
        tool_call_id: String,
        /// 这一组题，原样。题号与选项号是桥签发的，答的时候原样交回去。
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
    RunFailed {
        message: String,
        /// 这一轮**跑完了**，只是本机的帧记录掉了帧（`lost`）。
        ///
        /// 账要说实话（掉过帧的一轮不报正常结束），但这不是「这一轮失败了」：
        /// 屏幕该照常收尾，不该把一句内部诊断当失败横幅弹给人。
        degraded: bool,
    },
}
