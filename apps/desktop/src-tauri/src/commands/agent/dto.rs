//! 这一层交给渲染进程的类型。
//!
//! 每一个都带 specta 标注，绑定由它们生成。形状只为界面服务：库里的行、协议
//! 里的帧都不是这个样子，翻译在各自的模块里做。

use std::collections::HashMap;

use poietica_agent_runtime_native::{
    AnswerMethod, Decision, QuestionAnswer, QuestionResponse, Scope, SessionUsageSnapshot,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, value::RawValue};
use specta::Type;

/// 起一个 agent 进程要说清的那件事。
///
/// 不带 argv：程序在哪是这台机器上的事实，由原生侧解析一次（runtime.rs 的
/// outfit）。渲染层报一个程序路径过来，参数白名单就挡不住它。
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentLaunch {
    /// 要启动的 agent。它决定受控 home 落在哪里。
    pub agent_id: String,
}

/// 一张随这一句话送出去的图片，按它在交付注册表里的位置点名。
///
/// 字节不再跨 IPC。它们在用户把文件放进输入框的那一刻就已经在原生侧了
/// （见 commands/asset.rs 的 asset_import 与 asset_upload），这里交回来的
/// 只是取得它的两个令牌 —— 一次提问因此不再搬运任何字节，无论那张图多大。
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentPromptAsset {
    /// 这张图挂在哪条资产会话下（输入框那一条）。
    pub session_token: String,
    /// 它在那条会话里的令牌，也就是内容摘要。
    pub asset_token: String,
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
    /// What the user typed.
    pub text: String,
    /// Selector values committed as part of this prompt.
    pub configuration: Vec<AgentPromptConfiguration>,
    /// 这一句带的图片，按它们在交付注册表里的位置点名。
    ///
    /// 与 text 是同一句话的两半，所以判空要一起判：只挑了图、没打字是一句
    /// 完整的话。
    pub assets: Vec<AgentPromptAsset>,
    /// 与正文和附件同一次 prompt 提交的 Skill。
    pub skills: Vec<AgentPromptSkill>,
    /// The conversation this turn belongs to, when the interface names one.
    pub thread_id: Option<String>,
    /// 起哪个 agent。
    pub launch: AgentLaunch,
    /// The working directory the session is created against.
    pub cwd: Option<String>,
}

/// What the interface needs to follow the turn it just started.
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentPromptResult {
    /// 这一轮发到了哪条会话。它的每一帧都带着同一个号。
    pub session_id: String,
}

/// 人能给出的答复。
///
/// 取消不在其中：那不是人答的，是没有人答时这一侧的收场（recorder 的
/// record_pending_cancelled）。取值域由类型定死，所以别的词根本反序列化不出来。
#[derive(Clone, Copy, Debug, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum AgentApprovalDecision {
    Approved,
    Rejected,
}

/// 「这条会话都照此办理」。kap 只有这一个取值（approvalScopeSchema）。
#[derive(Clone, Copy, Debug, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum AgentApprovalScope {
    Session,
}

/// A user's answer to a permission request.
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentResolvePermissionRequest {
    /// The request being answered.
    pub request_id: String,
    /// 放行还是拒绝。
    pub decision: AgentApprovalDecision,
    /// 带上它就是「这条会话都照此办理」；只此一次时缺席。
    pub scope: Option<AgentApprovalScope>,
}

/// 把界面报来的答复翻成运行时的域类型。
///
/// 没有校验可做：不合法的词在 serde 那一步就已经被拒掉了。
pub(super) fn decided(request: &AgentResolvePermissionRequest) -> Decision {
    match request.decision {
        AgentApprovalDecision::Approved => Decision::Approved {
            scope: request
                .scope
                .map(|AgentApprovalScope::Session| Scope::Session),
        },
        AgentApprovalDecision::Rejected => Decision::Rejected,
    }
}

/// 要并进这一轮的那几条排队提问。
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSteerRequest {
    pub thread_id: String,
    /// 号由 kap 签发（prompt.queued 的 promptId）：队列不在这一侧，所以收号不收话。
    pub prompt_ids: Vec<String>,
}

/// 要撤掉的那条排队提问。
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentAbortPromptRequest {
    pub thread_id: String,
    pub prompt_id: String,
}

/// 要停的那条对话。
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentCancelRequest {
    /// The conversation whose turn should stop.
    pub thread_id: String,
}

/// What a session selector is for.
///
/// These are the categories the protocol defines. A category the agent
/// invents beyond them arrives as other and is still shown.
#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AgentConfigPurpose {
    /// How tool approvals are decided.
    Permission,
    /// Independent Plan, Goal and Swarm controls.
    Mode,
    /// Which model answers.
    Model,
    /// How long the model deliberates before answering.
    Thought,
    /// Something the agent named itself.
    Other,
}

/// One value a selector will accept.
#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigChoice {
    /// The value sent back when this one is picked.
    pub value: String,
    /// The name the agent gave it.
    pub label: String,
    /// The explanation the agent gave, where it gave one.
    pub detail: Option<String>,
}

/// One selector the running session offers.
#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigControl {
    /// The identifier the agent answers to when the value is changed.
    pub id: String,
    /// The name the agent gave this selector.
    pub label: String,
    /// The explanation the agent gave, where it gave one.
    pub detail: Option<String>,
    /// Where this selector belongs on screen.
    pub purpose: AgentConfigPurpose,
    /// Enabling this selector is committed with the next prompt.
    pub applies_on_submit: bool,
    /// The value in force right now.
    pub current: String,
    /// Every value on offer.
    pub choices: Vec<AgentConfigChoice>,
}

/// 一条会话此刻占了多少上下文，以及它累计的输入构成。
///
/// kap 的 agent.status.updated 报的是仪表值：到达即替换，不是增量 —— 三格累计
/// 计数同帧到达，恒为最新整份（usage.total）。按读数算增量的是账本
/// （persistence 的 usage.rs），这一格只说现在。
#[derive(Clone, Copy, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionUsage {
    /// 已占用的 token 数。
    pub used: u32,
    /// 上下文窗口总量，token 数。
    pub size: u32,
    /// 累计输入里未命中缓存的 token（kap usage.total.inputOther）。
    pub input_other: u32,
    /// 累计输入里命中缓存的 token（kap usage.total.inputCacheRead）。
    pub input_cache_read: u32,
    /// 累计输入里写入缓存的 token（kap usage.total.inputCacheCreation）。
    pub input_cache_creation: u32,
}

/// 领域快照 -> 线上形状。数值按绑定能表达的宽度收窄，溢出即封顶 —— 与
/// `reported_goal` 同一条规矩。
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

/// agent 主动报来的一件会话级状态。
///
/// 会话号是它唯一带得出的地址：帧里没有对话，反查由渲染层用「开这条会话时是
/// 哪条对话」去做。它不出现在任何命令签名里，所以不进生成绑定 —— 事件不是命令。
///
/// 内部标签，所以线上是一个判别联合：`{ kind: "selectors", … }`。
#[derive(Clone, Debug, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentSessionEvent {
    /// 那条会话上现在的整张选择器表。
    #[serde(rename_all = "camelCase")]
    Selectors {
        session_id: String,
        selectors: Vec<AgentConfigControl>,
        goal: Option<AgentGoal>,
    },
    /// 那条会话此刻的上下文用量。
    #[serde(rename_all = "camelCase")]
    Usage {
        session_id: String,
        usage: AgentSessionUsage,
    },
}

/// A change made in the interface.
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSelectConfigRequest {
    /// The conversation the change applies to.
    pub thread_id: Option<String>,
    /// One of the selector identifiers the session reported.
    pub config_id: String,
    /// One of the values that selector offered.
    pub value: String,
    /// Goal creation uses the current composer draft as its objective.
    pub input: Option<String>,
}

/// 问这个 agent 提供什么，不点名任何一条对话。
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilitiesRequest {
    /// 起哪个 agent。
    pub launch: AgentLaunch,
    /// The working directory the session is created against.
    pub cwd: Option<String>,
}

/// The name a conversation carries before anything has named it.
pub(super) const FALLBACK_THREAD_TITLE: &str = "新建对话";

/// Reported when a thread was written but could not be read back.
pub(super) const NO_THREAD: &str = "the conversation was created but could not be read back";

/// Where a conversation's name came from.
///
/// A closed set of three, and the interface ranks on it: a name the user
/// typed is never replaced by one derived from the text.
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AgentTitleSource {
    /// Taken from the first thing the user said.
    Message,
    /// Shown before there was anything to take a name from.
    Fallback,
    /// The user typed it. Nothing derived replaces it.
    Manual,
}

/// One conversation, as a list of conversations and a tab strip need it.
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentThread {
    /// The stored conversation.
    pub thread_id: String,
    /// The agent session it is holding, where it holds one.
    pub session_id: Option<String>,
    /// The name to show for it.
    pub title: String,
    /// Where that name came from.
    pub title_source: AgentTitleSource,
    /// When it was last touched, in RFC 3339.
    pub updated_at: String,
    /// Whether it is held at the top of the list.
    pub pinned: bool,
    /// 它是在哪个工作目录里开的。列表按它分组；空表示默认那一个工作区
    /// （thread-order.ts 的 DEFAULT_WORKSPACE_ID 那一段说明了为什么）。
    pub workspace_root: Option<String>,
    /// 是否已经离开活动会话列表。
    pub archived: bool,
}

/// 一页帧从哪儿往前读。渲染层原样回传，不解释：它是库上那把唯一键。
#[derive(Debug, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentFrameCursor {
    /// 位置属于哪条会话。
    pub session_id: String,
    /// 它在那条会话上的位置。
    pub seq: u32,
}

/// 一页帧，以及更早那一页从哪儿接着读。
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentFramePage {
    /// 这一页的帧，按追加顺序。库里那一段字节，未解析。
    ///
    /// specta 没有 `RawValue` 的 `Type`，线上形状因此由 `type` 明写 ——
    /// 与 `Vec<Value>` 生成的绑定逐字相同。
    #[specta(type = Vec<Value>)]
    pub events: Vec<Box<RawValue>>,
    /// 更早那一页的读取位置；缺席就是前面没有了。
    pub before: Option<AgentFrameCursor>,
}

/// 要往前读的那条对话，以及从哪儿接着读。
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentEarlierFramesRequest {
    /// 往前读哪条对话。
    pub thread_id: String,
    /// 上一页交回的读取位置。
    pub before: AgentFrameCursor,
}

/// 要打开或创建的对话。操作由判别式表达，不用可空 id 猜。
#[derive(Debug, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentThreadTarget {
    #[serde(rename_all = "camelCase")]
    Create { thread_id: String },
    #[serde(rename_all = "camelCase")]
    Existing { thread_id: String },
}

/// 要打开的对话，以及必要时怎样启动 agent。
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentOpenThreadRequest {
    /// 创建与打开是两种显式操作；两者都携带稳定标识。
    pub target: AgentThreadTarget,
    /// 起哪个 agent。
    pub launch: AgentLaunch,
    /// The working directory the session is created against.
    pub cwd: Option<String>,
}

/// A conversation that was just opened, and what its session offers.
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentOpenedThread {
    /// The conversation itself.
    pub thread: AgentThread,
    /// What may be chosen for this session, as the agent reported it.
    pub selectors: Vec<AgentConfigControl>,
    /// 打开时从同一条会话读取的目标真相；缺席即未启用。
    pub goal: Option<AgentGoal>,
    /// 这条对话最新的那一页经过，由本地日志交回来。
    ///
    /// 库里记下的就是当时交给界面的那一批（journal.rs 的 FrameJournal
    /// record_frames），所以重开一条对话与看着它发生不可能对不上。
    ///
    /// 一页，不是全量：更早的按页里那个位置向 `agent_earlier_frames` 续读。
    pub frames: AgentFramePage,
    /// 上面那格为什么是它现在的样子。
    ///
    /// 空数组自己说不出区别：刚建的对话与一条打不开的旧对话长得一样。界面
    /// 要据此决定是画入口提示，还是画一句"这段历史在某某手里"。
    pub history: AgentHistory,
    /// 这条对话最近一次记下的上下文用量与累计输入构成。
    ///
    /// 来自本地账本，不来自这一次打开：用量是 volatile 推送（kap 不回放），
    /// 装载旧会话也不补报，所以重启后的第一眼只有账本答得上。缺席就是还没报过。
    pub usage: Option<AgentSessionUsage>,
}

/// A conversation the interface is renaming.
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentRenameThreadRequest {
    /// The conversation being renamed.
    pub thread_id: String,
    /// The name the user typed.
    pub title: String,
}

/// A conversation an action applies to, and nothing else.
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentThreadRequest {
    /// The conversation the action applies to.
    pub thread_id: String,
}

/// 要分叉的对话，以及必要时怎样启动 agent。
///
/// 带 launch 与 cwd，因为分叉的第一步可能要把 agent 起起来、把源会话装载成
/// 本次连接上活的地址 —— 与打开一条对话要说清的是同一批事。
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentForkThreadRequest {
    /// 从哪条对话分叉。
    pub thread_id: String,
    /// 分叉出的新对话叫什么。
    ///
    /// 名字由界面按命名规则算好（thread-title.ts 的 forkNameOf）：源名加下一
    /// 个序号。这一侧照改名那条防线收：去空白、按上限截断、拒绝空名。
    pub title: String,
    /// 分叉点：这一轮之后还有几轮。0 就是从最后一轮分叉。
    ///
    /// agent 那侧按它回退上下文，本机日志按同一个数截断 —— 屏幕与上下文
    /// 因此止于同一处。
    pub drop_turns: u32,
    /// 起哪个 agent。
    pub launch: AgentLaunch,
    /// The working directory the session is created against.
    pub cwd: Option<String>,
}

/// A conversation being archived or restored.
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentArchiveThreadRequest {
    /// The conversation the action applies to.
    pub thread_id: String,
    /// True archives it; false restores it.
    pub archived: bool,
}

/// A conversation being held at the top of the list, or released.
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentPinThreadRequest {
    /// The conversation the action applies to.
    pub thread_id: String,
    /// Whether it should be held at the top.
    pub pinned: bool,
}

/// 一段历史打不开的时候，是因为什么。
///
/// 两种，都不是这一侧的故障，也都不是可以重试的：会话在对面手里，而对面要么
/// 不是同一个 agent，要么自己也不留着了。
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AgentHistoryLoss {
    /// 这条对话是另一个 agent 开的。
    ///
    /// sessionId 活在各自 agent 的命名空间里，把 A 的号发给 B 只会换回一句
    /// `UnknownSession` —— 所以这里根本不发。
    OtherAgent,
    /// 号发过去了，agent 说它这边已经没有这条会话。
    Forgotten,
}

/// 这一次打开，屏幕上应该出现什么。
///
/// 空的经过说不出区别：刚建的对话是空的，理所应当；而一条聊过两小时的对话在
/// 换了 agent 之后也是空的。那不是"没有历史"，那是"有历史但拿不到"，两件事对
/// 人的意义完全不同。
///
/// 内部标签，所以线上是一个判别联合：`{ state: "live" }`、
/// `{ state: "unavailable", reason: …, owner: … }`。
#[derive(Debug, Serialize, Type)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum AgentHistory {
    /// 这条对话刚刚建出来，本来就没有经过。
    Fresh,
    /// 这一次没让 agent 重放经过。
    ///
    /// 提问和改设置走的就是这一路：它们不需要历史。打开一条会话已在本连接上活着
    /// 的对话也走它 —— addressing.rs 的快路径直接交回这一格，经过由本机日志重放
    /// 补上，界面照常收。
    Live,
    /// agent 把它装载回来了，`events` 就是它交出来的那一整段。
    Loaded,
    /// 打不开。说清是为什么，以及它在谁手里。
    #[serde(rename_all = "camelCase")]
    Unavailable {
        /// 为什么打不开。
        reason: AgentHistoryLoss,
        /// 持有这条对话的那个 agent；这一列存在之前写下的行没有。
        owner: Option<String>,
    },
}

/// 人是怎么答的这一组题。
///
/// 四个值就是 kap 的 questionAnswerMethodSchema。如实上报：官方把 click 丢掉，
/// 但改报成别的就是撒谎。
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum AgentQuestionMethod {
    Enter,
    Space,
    NumberKey,
    Click,
}

/// 一题答的是什么。
///
/// 判别联合，五支，与 kap 的 questionAnswerSchema 逐一对应，判别式与分支名逐字
/// 相同。摊平成「一个 kind 加几个可选格」会让「多选却没有选项」这种答复在类型上
/// 就合法。
#[derive(Debug, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentQuestionChoice {
    /// 选了一个。
    #[serde(rename_all = "camelCase")]
    Single { option_id: String },
    /// 选了几个。
    #[serde(rename_all = "camelCase")]
    Multi { option_ids: Vec<String> },
    /// 自己写了一句。
    Other { text: String },
    /// 选了几个，还自己写了一句。
    #[serde(rename_all = "camelCase")]
    MultiWithOther {
        option_ids: Vec<String>,
        other_text: String,
    },
    /// 这一题跳过。
    Skipped,
}

/// 一题一条答复，按题号点名。
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentQuestionAnswer {
    /// 题号，就是 kap 在这一组里现编的那个。
    pub question_id: String,
    /// 这一题答的是什么。
    pub answer: AgentQuestionChoice,
}

/// 一整组题的答复。
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentAnswerQuestionsRequest {
    /// 被回答的那一组。
    pub question_id: String,
    /// 逐题一条，一次交齐 —— 一组最多四题，问是一起问的。
    pub answers: Vec<AgentQuestionAnswer>,
    /// 人怎么答的，界面知道就报。
    pub method: Option<AgentQuestionMethod>,
    /// 整组的备注。
    ///
    /// wire 上它是合法的一格，但官方 server 收下之后不读它（routes/questions.ts
    /// 的 toInProcessResponse 只把 answers 与 method 交出去）。送它是因为契约里有
    /// 它，不是因为它今天有效果。
    pub note: Option<String>,
}

/// 要撤下的那一组题。
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentDismissQuestionsRequest {
    /// 被撤下的那一组。
    pub question_id: String,
}

/// 把界面报来的一组答复翻成运行时的域类型。
///
/// 号原样搬：题号与选项号都是 kap 现编的，这一层不解析也不校验 —— 合不合这一组
/// 题，由桌子对着它自己留下的那一组题判（agent-runtime 的 QuestionDesk::answer）。
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

/// 目标模式此刻的事实，线上形状。
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentGoal {
    pub objective: String,
    pub completion_criterion: Option<String>,
    pub status: String,
    pub turns_used: u32,
    pub tokens_used: u32,
    pub wall_clock_ms: u32,
}

/// 领域快照 -> 线上形状。数值按绑定能表达的宽度收窄，溢出即封顶。
#[must_use]
pub fn reported_goal(goal: poietica_agent_runtime_native::GoalSnapshot) -> AgentGoal {
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
