pub(crate) mod book;
pub(crate) mod bridge;
pub(crate) mod client;
pub(crate) mod config;
pub(crate) mod lifecycle;
pub(crate) mod observe;
pub(crate) mod selection;

pub use crate::wire::DeliverAs;
pub use book::SessionBook;
pub use client::{
    AgentClient, MediaBytes, PromptAttachment, PromptAttachmentKind, PromptSkill, ShareOutcome,
};
pub use config::{ConfigChoice, ConfigControl, ConfigPurpose, GoalSnapshot};
pub use selection::{ConfigSelection, apply_configurations, select_config};

use std::fmt;
use std::path::PathBuf;

use futures::channel::{mpsc, oneshot};
use futures::future::BoxFuture;

use crate::error::Result;
use crate::process::profile::ProcessEnvironment;

#[derive(Clone, Debug)]
pub struct AgentSpawn {
    /// 随包发的运行时名（Bun）。先在这个目录里找，再回落到 PATH。
    pub program: String,
    /// 随包发的文件所在目录：运行时可回落，入口不回落。
    pub bundled: PathBuf,
    /// 桥的入口文件名，相对 `bundled`；`program` 是承载它的运行时。
    pub entry: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    /// 只放非密文变量：密钥不走 env 也不走参数（Windows 上任何用户读得到别的进程的完整命令行）。
    pub env: ProcessEnvironment,
    pub home: PathBuf,
}

#[derive(Debug, Clone)]
pub enum SessionEvent {
    Selectors {
        session_id: String,
        controls: Vec<ConfigControl>,
        goal: Option<GoalSnapshot>,
    },
    Usage {
        session_id: String,
        usage: SessionUsageSnapshot,
    },
    /// 待发队列变了：谁排了一句、谁撤回了一句、模型在哪一刻真的看见了它。
    ///
    /// 队列的真相在 agent 里（它的 `getQueuedMessages`/`peekXQueue`），这条只是把它
    /// 此刻的样子推出去；读命令 `queue` 是同一份事实的另一个出口。
    Queue {
        session_id: String,
        queue: QueuedState,
    },
    /// 这一句在入队前就被取消了（abort 或用量预检竞态），**没有落进会话文件**。
    ///
    /// 上游 `setPromptDropped` 只在这两种竞态里响一次（agent-session.ts:6588、6600）。
    /// 不接它，用户那句话就凭空消失：屏幕上那条乐观记录还挂着，agent 永远不回应答。
    PromptDropped {
        session_id: String,
        text: String,
    },
    Transcript {
        session_id: String,
        payload: serde_json::Value,
    },
    /// agent 要问一个对话框（confirm、input、editor）。
    ///
    /// 原样转发上游 RpcExtensionUIRequest 的形状：本层不认识它的 method，也不该
    /// 认识 —— 解释归宿主。授权那一类不走这里（它翻成产品的 permission 帧），
    /// ask 工具的题组也不走（它翻成 QuestionsAsked，本层认得那份产品形状）。
    Dialog {
        session_id: String,
        request: serde_json::Value,
    },
    ModelCatalogChanged,
    Link(poietica_conversation::link::LinkState),
}

/// 待发队列此刻的样子与三个队列模式。
///
/// 字段与 packages/agent-bridge/src/protocol.ts 的 `QueuedState` 逐字对应（camelCase
/// 在桥那一侧折），所以这里不加第二个命名。`steering` 与 `follow_up` 只含**用户消息**：
/// 上游 `getQueuedMessages()` 挑的就是可恢复的那一批。
///
/// 上游的第三档 `aside` 不在这一份快照里，也不在本仓的产品面上（见 ADR 0034）。
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct QueuedState {
    /// 这份队列属于哪条会话。
    pub session_id: String,
    pub steering: Vec<String>,
    pub follow_up: Vec<String>,
    pub steering_mode: String,
    pub follow_up_mode: String,
    pub interrupt_mode: String,
}

/// 撤回交回来的那一句。上游还带图片（`RestoredQueuedMessage.images`），但产品这一侧
/// 的附件是原生资产令牌、不是 base64，接不回去，所以只交正文 —— 缺的那一格如实缺席，
/// 不编一个假 token。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WithdrawnMessage {
    pub text: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SessionUsageSnapshot {
    pub used: u64,
    pub size: u64,
    pub input_other: u64,
    pub input_cache_read: u64,
    pub input_cache_creation: u64,
    /// 此刻这份上下文的构成。缺席即这一份报数没带构成：屏幕退成只画总条。
    pub breakdown: Option<UsageBreakdownSnapshot>,
}

/// 此刻这份上下文的构成，与 agent 状态行里显示的那份逐格对应。
///
/// 七格全带，通用层不折：折过一次就会出现「屏幕上那一行的数不等于 agent 说的数」。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct UsageBreakdownSnapshot {
    pub system: u64,
    pub system_context: u64,
    pub tools: u64,
    pub skills: u64,
    pub messages: u64,
    pub free: u64,
    pub buffer: u64,
}

pub struct SessionEvents(mpsc::UnboundedReceiver<SessionEvent>);

impl SessionEvents {
    pub(crate) const fn new(events: mpsc::UnboundedReceiver<SessionEvent>) -> Self {
        Self(events)
    }

    pub async fn next(&mut self) -> Option<SessionEvent> {
        futures::StreamExt::next(&mut self.0).await
    }
}

impl fmt::Debug for SessionEvents {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionEvents")
            .finish_non_exhaustive()
    }
}

pub struct AgentConnection {
    pub stop: tokio_util::sync::CancellationToken,
    pub client: AgentClient,
    pub book: SessionBook,
    pub events: SessionEvents,
    pub handshake: oneshot::Receiver<Result<Handshake>>,
    /// 必须在 tokio runtime 里 spawn：驱动器用 tokio 进程/时间与 select!，无 reactor 轮询会 panic。
    pub driver: BoxFuture<'static, Result<()>>,
}

impl fmt::Debug for AgentConnection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AgentConnection")
            .field("client", &self.client)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone)]
pub struct Handshake {
    pub session_id: String,
}

#[derive(Debug, Clone)]
pub enum McpStatus {
    Connected,
    Connecting,
    Disconnected,
    Error,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CapabilityReadiness {
    NotInstalled,
    Partial,
    Ready,
    Unsupported,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CapabilityInstall {
    pub running: bool,
    pub step: Option<String>,
    pub percent: Option<f64>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Capability {
    pub id: String,
    pub plugin_id: Option<String>,
    pub label: String,
    pub supported: bool,
    pub state: CapabilityReadiness,
    pub install: CapabilityInstall,
}

/// agent 的浏览器控制设置：开关、有头无头，以及附着用的 CDP 端点
/// （None 即托管启动——agent 自己拉起一个 Chromium）。
#[derive(Clone, Debug, PartialEq)]
pub struct BrowserSettings {
    pub enabled: bool,
    pub headless: bool,
    pub cdp_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct McpServer {
    pub id: String,
    pub name: String,
    pub status: McpStatus,
    pub tool_count: u32,
    pub last_error: Option<String>,
}

/// 可否激活不在本地判：官方在服务端用 isUserActivatableSkillType 拦（protocol/skill.ts）。
#[derive(Debug, Clone)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub path: String,
    pub source: String,
    pub kind: Option<String>,
    pub disable_model_invocation: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct OpenedSession {
    pub session_id: String,
    pub selectors: Vec<ConfigControl>,
}

#[derive(Debug, Clone)]
pub struct SessionEntry {
    pub session_id: String,
    pub title: Option<String>,
    pub updated_at: Option<String>,
}
