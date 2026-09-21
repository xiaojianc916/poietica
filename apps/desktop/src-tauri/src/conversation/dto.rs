//! 这一层交给渲染进程的类型，绑定由它们生成。

use std::collections::HashMap;

use poietica_kap_client::{
    AnswerMethod, ApprovalResponse, Decision, QuestionAnswer, QuestionResponse, Scope,
    SessionUsageSnapshot,
};
use serde::{Deserialize, Serialize};
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

/// A prompt, and how to start the agent if it is not running yet.
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentPromptRequest {
    pub text: String,
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
pub struct AgentSteerRequest {
    pub thread_id: String,
    /// 号由 kap 签发（prompt.queued 的 promptId）：队列不在这一侧，收号不收话。
    pub prompt_ids: Vec<String>,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentAbortPromptRequest {
    pub thread_id: String,
    pub prompt_id: String,
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
}

pub(super) fn reported_usage(usage: SessionUsageSnapshot) -> AgentSessionUsage {
    let narrow = |value: u64| u32::try_from(value).unwrap_or(u32::MAX);

    AgentSessionUsage {
        used: narrow(usage.used),
        size: narrow(usage.size),
        input_other: narrow(usage.input_other),
        input_cache_read: narrow(usage.input_cache_read),
        input_cache_creation: narrow(usage.input_cache_creation),
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

#[derive(Clone, Debug, Deserialize, Event, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentTranscriptEvent {
    pub session_id: String,
    pub json: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentTranscriptJson {
    pub json: String,
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

/// Fresh 是本来就没有经过，Live 是有经过但这次没让 agent 重放——两种"空"对人的意义完全不同。
#[derive(Debug, Serialize, Type)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum AgentHistory {
    Fresh,
    Live,
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
pub fn reported_goal(goal: poietica_kap_client::GoalSnapshot) -> AgentGoal {
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
