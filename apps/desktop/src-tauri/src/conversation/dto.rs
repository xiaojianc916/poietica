//! 这一层交给渲染进程的类型，绑定由它们生成。

use std::collections::HashMap;

use poietica_agent_client::{
    AnswerMethod, ApprovalResponse, Decision, QuestionAnswer, QuestionResponse, Scope,
    SessionUsageSnapshot,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use tauri_specta::Event;

/// 不带 argv：渲染层报程序路径过来，参数白名单就挡不住它，程序由原生侧解析。
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentLaunch {
    pub agent_id: String,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentPromptAsset {
    pub session_token: String,
    pub asset_token: String,
    pub filename: String,
    /// Image 走内存注册表；File 是暂存在磁盘上的通用文件。
    pub kind: crate::asset::AssetKind,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentPromptSkill {
    pub name: String,
    pub args: Option<String>,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentPromptConfiguration {
    pub id: String,
    pub value: String,
}

/// 这句话怎么交给 agent：omp 的三层插话，打断程度递减。
///
/// 与 packages/agent-bridge/src/protocol.ts 的 `deliverAs` 以及
/// crates/conversation 的 `DeliverAs` 三处同名同值，判别式只在各自的边界上翻一次。
#[derive(Clone, Copy, Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AgentDeliverAs {
    /// 开一轮（空闲时的正常发送）。
    Turn,
    /// 插进正在跑的那一轮：在工具批次之间被模型看到。
    Steer,
    /// 不打断：这一轮跑完后自动作为下一轮输入。
    FollowUp,
    /// 完全非中断：在 step 边界静默注入，绝不打断在跑的工具批。
    Aside,
}

impl From<AgentDeliverAs> for poietica_conversation::turn::DeliverAs {
    fn from(value: AgentDeliverAs) -> Self {
        match value {
            AgentDeliverAs::Turn => Self::Turn,
            AgentDeliverAs::Steer => Self::Steer,
            AgentDeliverAs::FollowUp => Self::FollowUp,
            AgentDeliverAs::Aside => Self::Aside,
        }
    }
}

/// A prompt, and how to start the agent if it is not running yet.
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentPromptRequest {
    pub text: String,
    /// 这一句走哪一层。缺席即开一轮：老调用方（自动化、恢复）不传这一格。
    #[serde(default = "default_deliver_as")]
    pub deliver_as: AgentDeliverAs,
    pub configuration: Vec<AgentPromptConfiguration>,
    /// 与 text 是同一句话的两半：只挑了图、没打字也是一句完整的话，判空要一起判。
    pub assets: Vec<AgentPromptAsset>,
    pub skills: Vec<AgentPromptSkill>,
    pub thread_id: Option<String>,
    pub launch: AgentLaunch,
    pub cwd: Option<String>,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentPromptResult {
    pub session_id: String,
    pub prompt_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum AgentApprovalDecision {
    Approved,
    Rejected,
}

/// kap 的 approvalScopeSchema 只有这一个取值。
#[derive(Clone, Copy, Debug, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum AgentApprovalScope {
    Session,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentResolvePermissionRequest {
    pub request_id: String,
    pub decision: AgentApprovalDecision,
    pub scope: Option<AgentApprovalScope>,
    pub selected_label: Option<String>,
    pub feedback: Option<String>,
}

pub(super) fn decided(request: &AgentResolvePermissionRequest) -> ApprovalResponse {
    ApprovalResponse {
        decision: match request.decision {
            AgentApprovalDecision::Approved => Decision::Approved {
                scope: request
                    .scope
                    .map(|AgentApprovalScope::Session| Scope::Session),
            },
            AgentApprovalDecision::Rejected => Decision::Rejected,
        },
        selected_label: request.selected_label.clone(),
        feedback: request.feedback.clone(),
    }
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentAbortPromptRequest {
    pub thread_id: String,
    pub prompt_id: String,
}

/// 待发队列此刻的样子：两层正文 + 三个模式。
///
/// 队列的真相在 agent 里，这一层只搬。`steering` 与 `followUp` 都是已经交给 agent 的
/// 用户消息正文；aside 不在其中（它走旁路，上游的 queuedMessageCount 也不算它）。
#[derive(Clone, Debug, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentQueuedState {
    pub session_id: String,
    pub steering: Vec<String>,
    pub follow_up: Vec<String>,
    pub steering_mode: String,
    pub follow_up_mode: String,
    pub interrupt_mode: String,
}

impl From<poietica_agent_client::QueuedState> for AgentQueuedState {
    fn from(queue: poietica_agent_client::QueuedState) -> Self {
        Self {
            session_id: queue.session_id,
            steering: queue.steering,
            follow_up: queue.follow_up,
            steering_mode: queue.steering_mode,
            follow_up_mode: queue.follow_up_mode,
            interrupt_mode: queue.interrupt_mode,
        }
    }
}

/// 撤回交回来的那一句；空队列时整格是 null。
#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentWithdrawnMessage {
    pub text: String,
}

/// 改队列模式；缺席的格不改。
#[derive(Clone, Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentDeliveryModesRequest {
    #[serde(default)]
    pub steering_mode: Option<String>,
    #[serde(default)]
    pub follow_up_mode: Option<String>,
    #[serde(default)]
    pub interrupt_mode: Option<String>,
}

const fn default_deliver_as() -> AgentDeliverAs {
    AgentDeliverAs::Turn
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentCancelRequest {
    pub thread_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AgentConfigPurpose {
    Permission,
    Mode,
    Model,
    Thought,
    Other,
}

#[derive(Clone, Debug, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigChoice {
    pub value: String,
    pub label: String,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigControl {
    pub id: String,
    pub label: String,
    pub detail: Option<String>,
    pub purpose: AgentConfigPurpose,
    pub applies_on_submit: bool,
    pub current: String,
    pub choices: Vec<AgentConfigChoice>,
}

/// kap 的 agent.status.updated 报的是仪表值：到达即替换，不是增量；按读数算增量的是账本。
#[derive(Clone, Copy, Debug, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionUsage {
    pub used: u32,
    pub size: u32,
    pub input_other: u32,
    pub input_cache_read: u32,
    pub input_cache_creation: u32,
    /// 此刻这份上下文的构成。缺席即这一份报数没带构成：屏幕退成只画总条。
    pub breakdown: Option<AgentUsageBreakdown>,
}

/// 上下文构成，与 agent 状态行里显示的那份逐格对应。
#[derive(Clone, Copy, Debug, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsageBreakdown {
    pub system_prompt: u32,
    pub system_context: u32,
    pub system_tools: u32,
    pub skills: u32,
    pub messages: u32,
    pub free: u32,
    pub auto_compact_buffer: u32,
}

pub(super) fn reported_usage(usage: SessionUsageSnapshot) -> AgentSessionUsage {
    let narrow = |value: u64| u32::try_from(value).unwrap_or(u32::MAX);

    AgentSessionUsage {
        used: narrow(usage.used),
        size: narrow(usage.size),
        input_other: narrow(usage.input_other),
        input_cache_read: narrow(usage.input_cache_read),
        input_cache_creation: narrow(usage.input_cache_creation),
        breakdown: usage.breakdown.map(|breakdown| AgentUsageBreakdown {
            system_prompt: narrow(breakdown.system),
            system_context: narrow(breakdown.system_context),
            system_tools: narrow(breakdown.tools),
            skills: narrow(breakdown.skills),
            messages: narrow(breakdown.messages),
            free: narrow(breakdown.free),
            auto_compact_buffer: narrow(breakdown.buffer),
        }),
    }
}

#[derive(Clone, Debug, Deserialize, Event, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentSessionEvent {
    #[serde(rename_all = "camelCase")]
    Selectors {
        session_id: String,
        selectors: Vec<AgentConfigControl>,
        goal: Option<AgentGoal>,
    },
    #[serde(rename_all = "camelCase")]
    Usage {
        session_id: String,
        usage: AgentSessionUsage,
    },
    /// provider、模型或默认模型的真身以它为准：收到即作废缓存重问。
    ModelCatalogChanged,
    /// 待发队列变了：谁排了一句、谁撤回了一句、模型在哪一刻真的看见了它。
    ///
    /// 队列的真相在 agent 里。这条只把此刻的样子推出去，`agent_queue` 是同一份事实的
    /// 另一个出口（断线重连、刚打开一条对话时读它）。
    #[serde(rename_all = "camelCase")]
    Queue {
        session_id: String,
        queue: AgentQueuedState,
    },
    /// 这一句在入队前就被取消了（abort 或用量预检竞态），**没有落进会话文件**。
    ///
    /// 收到它就要把屏幕上那条乐观记录收成失败：上游不会为它发任何 transcript 帧
    /// （它压根没进会话）。正文仍可由失败横幅取回输入框。
    #[serde(rename_all = "camelCase")]
    PromptDropped { session_id: String, text: String },
    /// agent 要问一个对话框（confirm / input / editor）。
    ///
    /// `request` 是 agent 自己那份形状，原样转发 —— 本层不认识它，也不该认识。
    /// 授权那一类不走这里（它走 permission_requested 那帧）；ask 工具的题组也不走
    /// 这里（它走 questions_asked，产品形状，由提问桌收答复）。
    #[serde(rename_all = "camelCase")]
    Dialog { session_id: String, request: Value },
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSelectConfigRequest {
    pub thread_id: Option<String>,
    pub config_id: String,
    pub value: String,
    pub input: Option<String>,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilitiesRequest {
    pub launch: AgentLaunch,
    pub cwd: Option<String>,
}

pub(super) const NO_THREAD: &str = "the conversation was created but could not be read back";

/// 界面按它排序：用户手打的名字永不被派生名替换。
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AgentTitleSource {
    Message,
    Generated,
    Fallback,
    Manual,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentThread {
    pub thread_id: String,
    pub session_id: Option<String>,
    pub title: String,
    pub title_source: AgentTitleSource,
    pub updated_at: String,
    pub pinned: bool,
    /// 它是在哪个工作目录里开的；空表示默认那一个工作区。
    pub workspace_root: Option<String>,
    pub archived: bool,
}

#[derive(Debug, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentThreadTarget {
    #[serde(rename_all = "camelCase")]
    Create { thread_id: String },
    #[serde(rename_all = "camelCase")]
    Existing { thread_id: String },
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentOpenThreadRequest {
    pub target: AgentThreadTarget,
    pub launch: AgentLaunch,
    pub cwd: Option<String>,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentThreadSnapshot {
    pub thread: AgentThread,
    pub usage: Option<AgentSessionUsage>,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentOpenedThread {
    pub thread: AgentThread,
    pub selectors: Vec<AgentConfigControl>,
    pub goal: Option<AgentGoal>,
    pub history: AgentHistory,
    pub transcript: AgentTranscriptJson,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentRenameThreadRequest {
    pub thread_id: String,
    pub title: String,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentExportThreadRequest {
    pub thread_id: String,
    pub launch: AgentLaunch,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentShareThreadRequest {
    pub thread_id: String,
    pub launch: AgentLaunch,
}

/// 一次分享的结果。
///
/// 只有两格。`url` 是给人点的那一条链接 —— **它同时是读取凭据**（omp 的形状是
/// `<serverUrl>/<id>#<key>`，`#` 之后是解密密钥），所以它只往界面上走，不进日志、
/// 不进错误文案（`ShareOutcome` 的手写 Debug 就是这条纪律的落点）。
///
/// `truncated` 如实来自 agent：为真表示内容为塞进上传预算被裁过。绝不替它猜一个
/// false —— 那等于替 agent 断言「内容是完整的」。
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSharedThread {
    pub url: String,
    pub truncated: bool,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentThreadRequest {
    pub thread_id: String,
}

/// 载荷以 JSON 文本透传：契约钉在 vendored @poietica/transcript 的 schema，这里不重抄第二份形状。
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentTranscriptRequest {
    pub session_id: String,
    pub agent_id: String,
    pub before_turn: Option<String>,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentTranscriptOpsRequest {
    pub session_id: String,
    pub agent_id: String,
    pub since_seq: i64,
}

/// 取一张 agent 会话媒体（历史图片）：webview 无法带 Bearer 直连，原生侧代取回 base64。
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionMediaRequest {
    pub session_id: String,
    pub file_id: String,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionMediaResult {
    pub content_type: String,
    pub base64: String,
}

#[derive(Clone, Debug, Deserialize, Event, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentTranscriptEvent {
    pub session_id: String,
    pub json: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentTranscriptJson {
    pub json: Value,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentForkThreadRequest {
    pub thread_id: String,
    pub title: String,
    /// 分叉点：这一轮之后还有几轮，0 就是从最后一轮分叉；agent 侧回退上下文与本机日志截断用同一个数，屏幕与上下文止于同一处。
    pub drop_turns: u32,
    pub launch: AgentLaunch,
    pub cwd: Option<String>,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentArchiveThreadRequest {
    pub thread_id: String,
    pub archived: bool,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentPinThreadRequest {
    pub thread_id: String,
    pub pinned: bool,
}

/// Fresh 是本来就没有经过；Loaded 是这次把已有会话重装了回来。
#[derive(Debug, Serialize, Type)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum AgentHistory {
    Fresh,
    Loaded,
}

/// 取值即 kap 的 questionAnswerMethodSchema；官方把 click 丢掉，仍如实上报。
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum AgentQuestionMethod {
    Enter,
    Space,
    NumberKey,
    Click,
}

/// 与 kap 的 questionAnswerSchema 逐一对应，判别式与分支名逐字相同，不摊平。
#[derive(Debug, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentQuestionChoice {
    #[serde(rename_all = "camelCase")]
    Single {
        option_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Multi {
        option_ids: Vec<String>,
    },
    Other {
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    MultiWithOther {
        option_ids: Vec<String>,
        other_text: String,
    },
    Skipped,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentQuestionAnswer {
    pub question_id: String,
    pub answer: AgentQuestionChoice,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentAnswerQuestionsRequest {
    pub question_id: String,
    pub answers: Vec<AgentQuestionAnswer>,
    pub method: Option<AgentQuestionMethod>,
    /// wire 上合法的一格，但官方 server 收下之后不读它（routes/questions.ts 的 toInProcessResponse）；送它是因为契约里有它。
    pub note: Option<String>,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentDismissQuestionsRequest {
    pub question_id: String,
}

pub(super) fn answered(request: AgentAnswerQuestionsRequest) -> QuestionResponse {
    let mut answers = HashMap::new();

    for AgentQuestionAnswer {
        question_id,
        answer,
    } in request.answers
    {
        let _replaced = answers.insert(question_id, chosen(answer));
    }

    QuestionResponse {
        answers,
        method: request.method.map(measured),
        note: request.note,
    }
}

fn chosen(answer: AgentQuestionChoice) -> QuestionAnswer {
    match answer {
        AgentQuestionChoice::Single { option_id } => QuestionAnswer::Single { option_id },
        AgentQuestionChoice::Multi { option_ids } => QuestionAnswer::Multi { option_ids },
        AgentQuestionChoice::Other { text } => QuestionAnswer::Other { text },
        AgentQuestionChoice::MultiWithOther {
            option_ids,
            other_text,
        } => QuestionAnswer::MultiWithOther {
            option_ids,
            other_text,
        },
        AgentQuestionChoice::Skipped => QuestionAnswer::Skipped,
    }
}

const fn measured(method: AgentQuestionMethod) -> AnswerMethod {
    match method {
        AgentQuestionMethod::Enter => AnswerMethod::Enter,
        AgentQuestionMethod::Space => AnswerMethod::Space,
        AgentQuestionMethod::NumberKey => AnswerMethod::NumberKey,
        AgentQuestionMethod::Click => AnswerMethod::Click,
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentGoal {
    pub objective: String,
    pub completion_criterion: Option<String>,
    pub status: String,
    pub turns_used: u32,
    pub tokens_used: u32,
    pub wall_clock_ms: u32,
}

#[must_use]
pub fn reported_goal(goal: poietica_agent_client::GoalSnapshot) -> AgentGoal {
    let narrow = |value: u64| u32::try_from(value).unwrap_or(u32::MAX);

    AgentGoal {
        objective: goal.objective,
        completion_criterion: goal.completion_criterion,
        status: goal.status,
        turns_used: narrow(goal.turns_used),
        tokens_used: narrow(goal.tokens_used),
        wall_clock_ms: narrow(goal.wall_clock_ms),
    }
}
