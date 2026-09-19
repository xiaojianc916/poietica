//! 一条连接说得出口的名词：两边都要认识的类型。起进程（process/）、走链路
//! （connection/）、跑一轮（本目录 driver/client/router）各归各的模块。

pub(crate) mod book;
pub(crate) mod client;
pub(crate) mod config;
pub(crate) mod driver;
pub(crate) mod export;
pub(crate) mod reconcile;
pub(crate) mod rest;
pub(crate) mod router;
pub(crate) mod selection;
mod tasks;

pub use book::SessionBook;
pub use client::{AgentClient, PromptAttachment, PromptSkill};
pub use config::{
    ConfigChoice, ConfigControl, ConfigPurpose, GoalSnapshot, controls, goal_snapshot,
    selector_patch,
};
pub use selection::{ConfigSelection, apply_configurations, select_config};

use std::fmt;
use std::path::PathBuf;

use futures::channel::{mpsc, oneshot};
use futures::future::BoxFuture;

use crate::error::Result;
use crate::process::profile::ProcessEnvironment;

/// How the agent process is started.
#[derive(Clone, Debug)]
pub struct AgentSpawn {
    /// 可执行文件名或路径，不经过 shell。进程只是宿主：协议在 loopback 的
    /// HTTP + WebSocket 上说，stderr 只用于日志。名字与参数分开存 —— 拼成一行
    /// 再切回来有损（POSIX 词法会吃掉 Windows 路径的反斜杠）；Zed 的
    /// `AgentServerCommand` 同样是 path/args/env 三元组。
    pub program: String,
    /// 传给它的参数，逐个原样递给进程，不做任何引号或转义处理。
    pub args: Vec<String>,
    /// The working directory the session is created against.
    pub cwd: PathBuf,
    /// Environment variables the child process is started with.
    ///
    /// 只放非密文变量。密钥不走这里（由 agent 自己的 CLI 写进受控 home 的配置），
    /// 也不走参数 —— Windows 上任何用户都读得到别的进程的完整命令行。
    pub env: ProcessEnvironment,
    /// 这家 agent 读写的家：实例注册表与 server.token 都在它下面。由组合层算，
    /// 传输层不认识任何一家 agent 的环境变量名。
    pub home: PathBuf,
}

/// agent 主动报的一件会话级状态，不属于任何一轮：到达时刻多半没有轮次在飞，
/// 而轮外的运行帧按规矩丢弃 —— 所以它有自己的路。会话号是它唯一带得出的地址，
/// 载荷恒为整份、到达即替换。载荷的形状由这个 enum 定死：字段名拼错是编译
/// 错误，不是界面上一格空白。
#[derive(Debug, Clone)]
pub enum SessionEvent {
    /// 这条会话现在的整张选择器表，以及目标模式此刻的事实。
    Selectors {
        session_id: String,
        controls: Vec<ConfigControl>,
        goal: Option<GoalSnapshot>,
    },
    /// 这条会话此刻的上下文用量，由 driver 从 agent.status.updated 读出来。
    Usage {
        session_id: String,
        usage: SessionUsageSnapshot,
    },
    /// 这条会话的事件流读到哪儿了。轮终报一次：一轮之内那些位置没有人会拿去
    /// 续订，而一帧写一次库正是持久层禁掉的事（persistence 的 record_frames）。
    Cursor {
        session_id: String,
        cursor: Cursor,
    },
    /// 这条会话的读点作废了：kap 说那一段流断了（resync_required），接不下去。
    CursorLost {
        session_id: String,
    },

    Transcript {
        session_id: String,
        payload: serde_json::Value,
    },
    ModelCatalogChanged,
    /// 这条连接此刻的链路态。
    Link(poietica_conversation::link::LinkState),
}

/// 一条会话此刻的上下文读数，与它累计的输入构成。kap 的 agent.status.updated
/// 报的是仪表值：到达即替换，不是增量。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SessionUsageSnapshot {
    /// 已占用的 token 数（contextTokens）。
    pub used: u64,
    /// 上下文窗口总量（maxContextTokens）。
    pub size: u64,
    /// 累计输入里未命中缓存的 token（usage.total.inputOther）。
    pub input_other: u64,
    /// 累计输入里命中缓存的 token（usage.total.inputCacheRead）。
    pub input_cache_read: u64,
    /// 累计输入里写入缓存的 token（usage.total.inputCacheCreation）。
    pub input_cache_creation: u64,
}

/// kap 的事件流上，一条会话已经被读到的位置。位置由 server 签发（信封 seq，跨
/// 守护进程重启有效），纪元标记流段；重新订阅原样报回去，server 才知道从哪帧
/// 接着发（contracts/kap/asyncapi.json 的 subscribe 载荷）。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Cursor {
    /// 信封上的 seq。
    pub seq: i64,
    /// 那一段流的纪元；server 没报就是空。
    pub epoch: Option<String>,
}

/// 一条连接上的会话级状态流，接收端；组合根把它排干到界面事件，通道在驱动器
/// 退出时合上。通道类型包在这里，不把某一个执行器生态的类型名泄进公共字段。
pub struct SessionEvents(mpsc::UnboundedReceiver<SessionEvent>);

impl SessionEvents {
    pub(crate) const fn new(events: mpsc::UnboundedReceiver<SessionEvent>) -> Self {
        Self(events)
    }

    /// 收下一件；通道合上（连接走了）时得到 None。
    pub async fn next(&mut self) -> Option<SessionEvent> {
        futures::StreamExt::next(&mut self.0).await
    }
}

/// 通道没有可展示的内容，而本仓库要求每个公共类型都印得出来。
impl fmt::Debug for SessionEvents {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionEvents")
            .finish_non_exhaustive()
    }
}

/// The connection owner drives this future and awaits its descendants on shutdown.
pub struct AgentConnection {
    pub stop: tokio_util::sync::CancellationToken,
    /// Sends prompts, cancellation and shutdown to the connection.
    pub client: AgentClient,
    /// The sessions of this connection, keyed by the name the agent gave them.
    /// Held by the caller so a session opened later enters the same book the
    /// protocol handlers already read from.
    pub book: SessionBook,
    /// agent 主动报的会话级状态，往界面去的那条路。与运行帧分开：帧过了轮次
    /// 就不录，而这些事多半发生在轮外。
    pub events: SessionEvents,
    /// 握手谈成之后才知道的那几件事，或者握手为什么没成：失败带原因回来，
    /// 「要求先登录」「进程崩了」「版本谈不拢」不该都变成同一句「应用操作失败」。
    pub handshake: oneshot::Receiver<Result<Handshake>>,
    /// Must be spawned — in a tokio runtime: the driver uses tokio process/fs/
    /// time and select!, so polling it outside a reactor panics. The connection
    /// only lives while this future is polled.
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

/// 握手谈成之后才知道的事。kap 不谈 per-session 能力（能力只在
/// server_hello.capabilities，装载/归档/分叉/中止是路由面自带），这里只报锚会话名。
#[derive(Debug, Clone)]
pub struct Handshake {
    /// 这条连接自带的那个会话的名字。
    pub session_id: String,
}

#[derive(Debug, Clone)]
pub enum McpStatus {
    Connected,
    Connecting,
    Disconnected,
    Error,
}

/// KAP 对一项能力的就绪裁决。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CapabilityReadiness {
    NotInstalled,
    Partial,
    Ready,
    Unsupported,
}

/// KAP 持有的后台安装状态。
#[derive(Clone, Debug, PartialEq)]
pub struct CapabilityInstall {
    pub running: bool,
    pub step: Option<String>,
    pub percent: Option<f64>,
    pub error: Option<String>,
}

/// 一项能力的领域投影；wire 形状由生成契约先行校验。
#[derive(Clone, Debug, PartialEq)]
pub struct Capability {
    pub id: String,
    pub plugin_id: Option<String>,
    pub label: String,
    pub supported: bool,
    pub state: CapabilityReadiness,
    pub install: CapabilityInstall,
}

#[derive(Debug, Clone)]
pub struct McpServer {
    pub id: String,
    pub name: String,
    pub status: McpStatus,
    pub tool_count: u32,
    pub last_error: Option<String>,
}

/// kap 报的一条技能（protocol/skill.ts 的 skillDescriptorSchema）。可否激活不
/// 在这里判：官方在服务端用 isUserActivatableSkillType 拦，多一格本地判据就是
/// 多一份会分叉的事实。
#[derive(Debug, Clone)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub path: String,
    /// project / user / extra / builtin。
    pub source: String,
    pub kind: Option<String>,
    pub disable_model_invocation: Option<bool>,
}

/// A session the agent just opened, and the selectors it offers for it.
#[derive(Debug, Clone)]
pub struct OpenedSession {
    pub session_id: String,
    pub selectors: Vec<ConfigControl>,
}

/// One line of the agent's own session list.
#[derive(Debug, Clone)]
pub struct SessionEntry {
    pub session_id: String,
    pub title: Option<String>,
    pub updated_at: Option<String>,
}
