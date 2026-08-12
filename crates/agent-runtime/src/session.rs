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

/// agent 主动报的一份选择器表。
///
/// 事件载荷：会话号就是它的寻址（帧没有别的地址），界面按它找到那条对话。
/// 这张表是可上屏的形状：协议枚举在帧离开原生层之前就被换成它了。
#[derive(Debug, Clone)]
pub struct SelectorReport {
    /// 这份表属于哪条会话。
    pub session_id: String,
    /// agent 刚报过来的整张选择器表。
    pub controls: Vec<ConfigControl>,
}

/// 一条连接上 agent 主动报的选择器表，接收端。
///
/// 组合根（桌面 seam）把它排干到界面事件；通道在驱动器退出时合上，那就是
/// 排空任务自己的终点。通道类型包在这里而不是把 futures 的类型泄进公共
/// 字段：这个 crate 对执行器不可知，接口上不该长出某一个执行器生态的类型名。
pub struct SelectorReports(mpsc::UnboundedReceiver<SelectorReport>);

impl SelectorReports {
    pub(crate) const fn new(reports: mpsc::UnboundedReceiver<SelectorReport>) -> Self {
        Self(reports)
    }

    /// 收下一份报告；通道合上（连接走了）时得到 None。
    pub async fn next(&mut self) -> Option<SelectorReport> {
        futures::StreamExt::next(&mut self.0).await
    }
}

/// 一个通道没有可展示的内容，但它长在一个公共结构上。
///
/// 本仓库要求每个公共类型都印得出来，所以这里手写一个而不是 derive：
/// derive 会把这个要求转嫁给通道自己的类型参数，而那是一件与这里无关
/// 的事。
impl fmt::Debug for SelectorReports {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SelectorReports")
            .finish_non_exhaustive()
    }
}

/// agent 主动报的一份命令表。
///
/// 与 [`SelectorReport`] 同一类东西：会话的状态，不是某一轮的内容。会话刚建好、
/// 装载刚结束、技能目录被改过时它都会到达，那些时刻多半没有一轮在飞。
///
/// 表里每一条是 ACP 自己的线上形状。这个 crate 一格都不认识它 —— 认识它的是读它
/// 的那一层，与 MCP 名册、图片块、停止原因同一条规矩。
#[derive(Debug, Clone)]
pub struct CommandReport {
    /// 报这张表的那条会话。
    pub session_id: String,
    /// 那条会话上现在的整张命令表。
    pub commands: Vec<serde_json::Value>,
}

/// 一条连接上 agent 主动报的命令表，接收端。
///
/// 与 [`SelectorReports`] 同一条规矩：通道类型包在这里，不把执行器生态的类型名
/// 泄进公共字段。
pub struct CommandReports(mpsc::UnboundedReceiver<CommandReport>);

impl CommandReports {
    pub(crate) const fn new(reports: mpsc::UnboundedReceiver<CommandReport>) -> Self {
        Self(reports)
    }

    /// 收下一份报告；通道合上（连接走了）时得到 None。
    pub async fn next(&mut self) -> Option<CommandReport> {
        futures::StreamExt::next(&mut self.0).await
    }
}

impl fmt::Debug for CommandReports {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CommandReports")
            .finish_non_exhaustive()
    }
}

/// agent 主动报的一份上下文用量（ACP usage_update）。
///
/// 与 CommandReport 同一类东西：会话的状态，不是某一轮的内容。Kimi 在答复落定
/// 之后才异步补报它（上游 acp-server 的 session.ts：settleDriver 先 resolve，
/// 再 emitUsageUpdate），那一刻轮次已经结束，运行帧通道按规矩丢帧 —— 所以它
/// 只能走这条路。
///
/// 载荷原样是 ACP 的线上形状。这个 crate 一格都不认识它 —— 认识它的是读它的
/// 那一层（packages/agent-contract 的 usage.ts），与命令表同一条规矩。
#[derive(Debug, Clone)]
pub struct UsageReport {
    /// 报这份用量的那条会话。
    pub session_id: String,
    /// 那条会话此刻的上下文用量，ACP 线上形状。
    pub usage: serde_json::Value,
}

/// 一条连接上 agent 主动报的用量，接收端。
///
/// 与 CommandReports 同一条规矩：通道类型包在这里，不把执行器生态的类型名
/// 泄进公共字段。
pub struct UsageReports(mpsc::UnboundedReceiver<UsageReport>);

impl UsageReports {
    pub(crate) const fn new(reports: mpsc::UnboundedReceiver<UsageReport>) -> Self {
        Self(reports)
    }

    /// 收下一份报告；通道合上（连接走了）时得到 None。
    pub async fn next(&mut self) -> Option<UsageReport> {
        futures::StreamExt::next(&mut self.0).await
    }
}

impl fmt::Debug for UsageReports {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("UsageReports")
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
    /// agent 主动报的选择器表，往界面去的那条路。
    ///
    /// 选择器是会话的状态，不是某一轮的内容：它变化的时刻多半不在任何一轮里
    /// （导入配置、终端 CLI、热重载），所以它有自己到达界面的路，而不搭运行
    /// 帧的车 —— 帧过了轮次就不录，是本仓库刻意的设计，保护的是日志。
    pub reports: SelectorReports,
    /// agent 主动报的命令表，往界面去的那条路。
    ///
    /// 与上面那一条分开，因为它们说的不是一件事：一个是这条会话能改什么，一个是
    /// 这条会话上敲得出什么。混成一条通道，接收方就只能靠一个字符串标签去分辨。
    pub commands: CommandReports,
    /// agent 主动报的上下文用量，往界面去的那条路。
    ///
    /// 它是会话的状态而不是某一轮的内容：Kimi 在轮次落定之后才补报它，帧通道
    /// 在轮外按规矩丢帧，所以它与选择器表、命令表同走会话状态这条路。
    pub usage: UsageReports,
    /// 握手谈成之后才知道的那几件事，或者握手为什么没成。
    ///
    /// 此前是 `Receiver<String>`：失败只能靠把发送端丢掉来表示，于是调用者收到
    /// 的是一个没有内容的 `Canceled` —— 「agent 要求先登录」「进程崩了」「协议
    /// 版本谈不拢」在它眼里是同一件事，屏幕上都是那句「应用操作失败」。原因在
    /// 类型上没有地方放，就不是漏写了一行日志，是这条路少了一半。
    ///
    /// 里面现在不只有会话名。agent 会不会装载一条旧会话，同样是握手才谈得出来
    /// 的事实，而它决定了「点开上次运行留下的对话」走哪条路 —— 此前这个事实在
    /// 类型上同样没有地方放，于是那条路只有一个走法。
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

/// 握手谈成之后才知道的事。
///
/// 每一件都只有 agent 说了算，而且都只在这一刻说一次。
#[derive(Debug, Clone)]
pub struct Handshake {
    /// 这条连接自带的那个会话的名字。
    pub session_id: String,
    /// agent 会不会把一条它以前开过的会话重新装载起来（ACP `session/load`）。
    pub can_load_session: bool,
    /// agent 会不会真的删掉一条会话（ACP session/delete）。
    ///
    /// 删除对话若只删本地那一份，agent 自己存的那一份原样留着 —— 屏幕上没了，
    /// 对面还在。那不是删除，是隐藏。这一件同样只有 agent 说了算，而且只在
    /// 握手这一刻说一次：它在 `sessionCapabilities.delete` 里。
    pub can_delete_session: bool,
    /// agent 会不会从一条已有会话分叉出一条新会话（ACP session/fork，UNSTABLE）。
    ///
    /// 与删除同一条规矩：只有 agent 说了算，声明在 sessionCapabilities.fork
    /// 里，只在握手这一刻说一次。
    pub can_fork_session: bool,
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
