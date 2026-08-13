//! 一条连接说得出口的名词。
//!
//! 怎么起进程、怎么开会话、怎么走一轮，都在 driver.rs；命令怎么发在
//! commands.rs。这里只有那几个两边都要认识的类型。

use std::fmt;
use std::path::PathBuf;

use futures::channel::{mpsc, oneshot};
use futures::future::BoxFuture;

use crate::commands::AgentClient;
use crate::config::ConfigControl;
use crate::error::Result;
use crate::sessions::SessionBook;

/// How the agent process is started.
#[derive(Clone, Debug)]
pub struct AgentSpawn {
    /// 可执行文件名或路径，不含参数，也不经过 shell。
    ///
    /// 进程本身就是传输层：协议在它的标准输入输出上说 JSON-RPC，所以这里没有
    /// 任何东西打开套接字。
    ///
    /// 名字与参数分开存，因为拼成一行再切回来是有损的：POSIX 词法会把 Windows
    /// 路径里的反斜杠当成转义符吃掉，带空格的路径会被切断。Zed 的
    /// `AgentServerCommand` 同样是 path/args/env 三元组，连跨进程的 protobuf
    /// （crates/proto/proto/ai.proto）都不降级成字符串。
    pub program: String,
    /// 传给它的参数，逐个原样递给进程，不做任何引号或转义处理。
    pub args: Vec<String>,
    /// The working directory the session is created against.
    pub cwd: PathBuf,
    /// Environment variables the child process is started with.
    ///
    /// 只放非密文的启动变量，受控 home 的路径就是其一。密钥不走这里：模式 B
    /// 下它们由 agent 自己的 CLI 写进那个 home 里的配置文件。也不走参数 ——
    /// Windows 上任何用户都读得到别的进程的完整命令行。
    pub env: Vec<(String, String)>,
}

/// agent 主动报的一件会话级状态。
///
/// 它不属于任何一轮：到达的时刻多半没有轮次在飞（导入配置、终端 CLI、热重载、
/// 答复落定之后补报的用量），而轮外的运行帧按规矩丢弃 —— 所以它有自己的路。
/// 会话号是它唯一带得出的地址；载荷恒为整份，到达即替换，重报无害。
///
/// 载荷里那些 Value 这个 crate 一格都不认识，认识它的是读它的那一层 —— 与 MCP
/// 名册、图片块、停止原因同一条规矩：线上形状才是契约。
#[derive(Debug, Clone)]
pub enum SessionEvent {
    /// 这条会话现在的整张选择器表。
    Selectors {
        session_id: String,
        controls: Vec<ConfigControl>,
    },
    /// 这条会话上现在的整张命令表，ACP 线上形状。
    Commands {
        session_id: String,
        commands: Vec<serde_json::Value>,
    },
    /// 这条会话此刻的上下文用量，ACP 线上形状。
    Usage {
        session_id: String,
        usage: serde_json::Value,
    },
}

/// 一条连接上的会话级状态流，接收端。
///
/// 组合根把它排干到界面事件；通道在驱动器退出时合上，那就是排空任务的终点。
/// 通道类型包在这里，不把某一个执行器生态的类型名泄进公共字段。
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

/// A connected session, before anything has been spawned onto a runtime.
///
/// The crate stays runtime-agnostic on purpose: it hands back a future and the
/// composition root decides which executor runs it.
pub struct AgentConnection {
    /// Sends prompts, cancellation and shutdown to the connection.
    pub client: AgentClient,
    /// The sessions of this connection, keyed by the name the agent gave
    /// them.
    ///
    /// Held by the caller so a session opened later is entered in the same
    /// book the protocol handlers already read from.
    pub book: SessionBook,
    /// agent 主动报的会话级状态，往界面去的那条路。
    ///
    /// 与运行帧分开：帧过了轮次就不录，而这些事多半发生在轮外。判别式在载荷
    /// 里 —— 与六种运行帧同走一条通道是同一条规矩。
    pub events: SessionEvents,
    /// 握手谈成之后才知道的那几件事，或者握手为什么没成。
    ///
    /// 失败带着原因回来：「要求先登录」「进程崩了」「版本谈不拢」是三件事，
    /// 屏幕上不该都变成同一句「应用操作失败」。
    pub handshake: oneshot::Receiver<Result<Handshake>>,
    /// Must be spawned; the connection only lives while this future is polled.
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

/// 装载一条旧会话的凭证（ACP `session/load`）。
///
/// 三张凭证都只有这个 crate 铸得出来，而铸造处只有握手一个：agent 在 initialize
/// 里声明了哪一项，`Handshake` 上就有哪一张。收凭证的是 `AgentClient` 上那三个
/// 方法 —— 「声明过才能调用」此前是三句文档，现在是签名，拿不出凭证的调用编译
/// 不过。
///
/// 与 `AgentClient::new` 收在 crate 内是同一个手法：能不能做这件事，铸造点说了
/// 算，不由调用点自觉。
#[derive(Clone, Copy, Debug)]
pub struct CanLoadSession(());

impl CanLoadSession {
    pub(crate) const fn granted() -> Self {
        Self(())
    }
}

/// 删掉一条会话的凭证（ACP session/delete）。
///
/// 删除对话若只删本地那一份，agent 自己存的那一份原样留着 —— 屏幕上没了，对面
/// 还在。那不是删除，是隐藏。声明在 `sessionCapabilities.delete` 里。
#[derive(Clone, Copy, Debug)]
pub struct CanDeleteSession(());

impl CanDeleteSession {
    pub(crate) const fn granted() -> Self {
        Self(())
    }
}

/// 分叉一条会话的凭证（ACP session/fork，UNSTABLE）。
///
/// 声明在 `sessionCapabilities.fork` 里。
#[derive(Clone, Copy, Debug)]
pub struct CanForkSession(());

impl CanForkSession {
    pub(crate) const fn granted() -> Self {
        Self(())
    }
}

/// 握手谈成之后才知道的事。
///
/// 每一件都只有 agent 说了算，而且都只在这一刻说一次。能力不是三个布尔：有没有
/// 这一项、谁调得动它，在类型上是同一件事。
#[derive(Debug, Clone)]
pub struct Handshake {
    /// 这条连接自带的那个会话的名字。
    pub session_id: String,
    /// agent 会不会把一条它以前开过的会话重新装载起来。
    pub loading: Option<CanLoadSession>,
    /// agent 会不会真的删掉一条会话。
    pub deleting: Option<CanDeleteSession>,
    /// agent 会不会从一条已有会话分叉出一条新会话。
    pub forking: Option<CanForkSession>,
}

/// A session the agent just opened, and the selectors it offers for it.
#[derive(Debug, Clone)]
pub struct OpenedSession {
    /// 装载一条旧会话时，agent 重放回来的那些帧，按发生顺序。
    ///
    /// 新开一条会话时是空的。形状与实时广播出去的帧相同，所以一条对话重开
    /// 之后与当时看着它发生不可能有出入 —— 它们由同一个 `acp_update` 做出来。
    pub events: Vec<serde_json::Value>,
    /// The name every frame of this session will carry.
    pub session_id: String,
    /// What may be chosen for this session, as the agent reported it.
    pub selectors: Vec<ConfigControl>,
}

/// One line of the agent's own session list.
#[derive(Debug, Clone)]
pub struct SessionEntry {
    /// The session this line describes.
    pub session_id: String,
    /// The title the agent gave it, if it has given one.
    pub title: Option<String>,
    /// When the agent last saw activity on it, as it reported it.
    pub updated_at: Option<String>,
}
