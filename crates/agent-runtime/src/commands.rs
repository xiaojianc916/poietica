use std::fmt;
use std::path::PathBuf;

use futures::channel::{mpsc, oneshot};
use serde_json::Value;

use crate::config::ConfigControl;
use crate::error::{AcpError, Refusal, Result};
use crate::recorder::FrameSink;
use crate::session::{
    CanCancelSession, CanDeleteSession, CanForkSession, CanLoadSession, OpenedSession, SessionEntry,
};

/// 这一轮随那句话一起送出去的一张图片。
///
/// base64 是协议自己的形状：ACP 的 image content block 就是一个 base64 的 data
/// 加一个 mimeType，所以这一格原样进请求体，中间不解码。
///
/// 一项一张图：字节给协议，地址给日志与屏幕。两件事分成两个平行的 Vec 就要靠
/// 下标对齐，而靠下标对齐的东西没有人会在它错位时报错。
pub struct PromptImage {
    /// base64 编码的原始字节，不带 `data:` 前缀。
    pub data: String,
    /// 例如 `image/png`。
    pub mime_type: String,
    /// 这张图在本机的资产协议地址，随这一轮的 run_started 帧写进日志。
    pub url: String,
}

/// 手写，因为 derive 会把整张图打出来。
///
/// 这一格装的是 base64，上限十六兆（见桌面 seam 的 `MAX_IMAGE_CHARS`），而它
/// 坐在 `Command` 里 —— 一行日志或一次 panic 的回溯就足以把它整个展开。那不是
/// 诊断信息，那是把日志冲掉；尺寸和类型才是诊断信息。
///
/// 与同文件里 `AgentClient` 那一份同一条规矩：Debug 说的是这东西现在什么状况，
/// 不是它装了什么。
impl fmt::Debug for PromptImage {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PromptImage")
            .field("mime_type", &self.mime_type)
            .field("base64_len", &self.data.len())
            .field("url", &self.url)
            .finish()
    }
}

/// What the driver is asked to do next.
///
/// 每一条都是一件事，而不是一个时段：驱动器把它变成一个自己的未来推进去，
/// 谁先回来谁先落账 —— 「正在等一个回应」不该成为拒绝其他命令的理由。
pub(crate) enum Command {
    /// Open one more session on the connection that is already running.
    NewSession {
        cwd: PathBuf,
        /// 这一条会话要挂的 MCP 服务器，ACP 的线上形状。
        ///
        /// 命令这一层不认识它。名册从渲染层原样过来，进来就是 JSON，所以物化
        /// 是驱动器里那一次反序列化 —— 手上是打好字的字段时相反，见 blocks_of。
        mcp_servers: Vec<Value>,
        reply: oneshot::Sender<Result<OpenedSession>>,
    },
    /// 让 agent 重新装载一条它以前开过的会话。
    ///
    /// 会话号是上一次运行存下来的。ACP 的 `session/load` 就是为跨进程恢复
    /// 而设的：装载之后这条会话仍然是它自己，历史因此还在 agent 手里 ——
    /// 与新开一条的分别不在于省一次握手，而在于上下文还在不在。
    LoadSession {
        session_id: String,
        cwd: PathBuf,
        reply: oneshot::Sender<Result<OpenedSession>>,
    },
    /// 让 agent 从一条已有会话分叉出一条新会话。
    ///
    /// 历史归 agent 所有，本地只有索引，所以「带着完整上下文另起一条」只能
    /// 是协议动作：ACP 的 session/fork 就是为它设的。源会话原样不动。
    ForkSession {
        session_id: String,
        cwd: PathBuf,
        reply: oneshot::Sender<Result<OpenedSession>>,
    },
    /// 让 agent 删掉一条它自己存着的会话。
    ///
    /// 删除对话不是本地的事：agent 那侧存着同一条对话的全文。ACP 的
    /// session/delete 就是为它设的。
    DeleteSession {
        session_id: String,
        reply: oneshot::Sender<Result<()>>,
    },
    /// Ask the agent which sessions it keeps, and what it calls them.
    Sessions {
        reply: oneshot::Sender<Result<Vec<SessionEntry>>>,
    },
    Prompt {
        /// The session this turn belongs to.
        ///
        /// 一条连接可以开很多条会话，agent 发回的每一帧都自报会话名。
        /// 提问也必须说出它是给哪一条的，否则它只能发给第一条。
        session_id: String,
        text: String,
        /// 这一句带的图片。
        ///
        /// 与 text 是同一句话的两半：只挑了图、没打字，是一句完整的话，
        /// 而不是一句空话 —— 判空的地方在桌面 seam，那里两者一起看。
        images: Vec<PromptImage>,
        /// 这一轮的帧交到哪里去。
        ///
        /// 记录器由驱动器造：位置要从这条会话的序号线上取，而那条线在它的
        /// 槽里 —— 组合根手上没有它，也不该有。
        frames: FrameSink,
        reply: oneshot::Sender<Result<String>>,
    },
    /// 停掉这条会话上正在飞的那一轮，只停它。
    ///
    /// 一条连接同时开着多条会话，而现在它们可以同时在飞：不点名的取消
    /// 停掉的会是别人那一轮。
    Cancel {
        session_id: String,
    },
    Shutdown,
    /// Answers with the selectors that session is currently offering.
    Selectors {
        session_id: String,
        reply: oneshot::Sender<Result<Vec<ConfigControl>>>,
    },
    /// Asks the agent to change one selector on one session.
    Select {
        session_id: String,
        config_id: String,
        value: String,
        reply: oneshot::Sender<Result<Vec<ConfigControl>>>,
    },
}

/// A handle onto a live connection. Cheap to clone, safe to hold anywhere.
#[derive(Clone)]
pub struct AgentClient {
    commands: mpsc::UnboundedSender<Command>,
}

impl fmt::Debug for AgentClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AgentClient")
            .field("connected", &!self.commands.is_closed())
            .finish_non_exhaustive()
    }
}

impl AgentClient {
    /// The sending end of a driver's command stream.
    pub(crate) const fn new(commands: mpsc::UnboundedSender<Command>) -> Self {
        Self { commands }
    }

    /// Opens one more session on the running connection.
    ///
    /// # Errors
    ///
    /// Fails when the connection is gone, when the agent refuses to open a
    /// session, or when the book cannot record the one it opened.
    pub async fn new_session(
        &self,
        cwd: PathBuf,
        mcp_servers: Vec<Value>,
    ) -> Result<OpenedSession> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::NewSession {
            cwd,
            mcp_servers,
            reply,
        })?;

        answer
            .await
            .map_err(|_dropped| AcpError::Refused(Refusal::Gone))?
    }

    /// Reloads a session this agent opened in an earlier run.
    ///
    /// 会话号原样交回去，agent 那侧把它重新装载起来，历史因此还在。凭证只从
    /// 握手来（`Handshake::loading`），所以没声明过的连接上写不出这一句调用。
    ///
    /// # Errors
    ///
    /// Fails when the connection is gone, or when the agent no longer keeps
    /// that session.
    pub async fn load_session(
        &self,
        _granted: CanLoadSession,
        session_id: String,
        cwd: PathBuf,
    ) -> Result<OpenedSession> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::LoadSession {
            session_id,
            cwd,
            reply,
        })?;

        answer
            .await
            .map_err(|_dropped| AcpError::Refused(Refusal::Gone))?
    }

    /// Forks a session the agent keeps into a new, independent one.
    ///
    /// 号原样交过去，agent 带着完整上下文开出一条新会话交回来 —— 源会话
    /// 原样不动。凭证只从握手来（`Handshake::forking`）。
    ///
    /// # Errors
    ///
    /// Fails when the connection is gone, or when the agent refuses to fork
    /// that session.
    pub async fn fork_session(
        &self,
        _granted: CanForkSession,
        session_id: String,
        cwd: PathBuf,
    ) -> Result<OpenedSession> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::ForkSession {
            session_id,
            cwd,
            reply,
        })?;

        answer
            .await
            .map_err(|_dropped| AcpError::Refused(Refusal::Gone))?
    }

    /// Asks the agent to delete one of the sessions it keeps.
    ///
    /// 凭证只从握手来（`Handshake::deleting`）。号删掉之后它不再指向任何
    /// 东西：驱动器会同时把它从选择器表和会话册子里抹掉。
    ///
    /// # Errors
    ///
    /// Fails when the connection is gone, or when the agent refuses to
    /// delete that session.
    pub async fn delete_session(
        &self,
        _granted: CanDeleteSession,
        session_id: String,
    ) -> Result<()> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::DeleteSession { session_id, reply })?;

        answer
            .await
            .map_err(|_dropped| AcpError::Refused(Refusal::Gone))?
    }

    /// Asks the agent which sessions it keeps, and what it calls them.
    ///
    /// The title is the agent's own, so it is the only honest source for
    /// one; a session it has not named yet reports none.
    ///
    /// # Errors
    ///
    /// Fails when the connection is gone or the agent refuses to list.
    pub async fn sessions(&self) -> Result<Vec<SessionEntry>> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::Sessions { reply })?;

        answer
            .await
            .map_err(|_dropped| AcpError::Refused(Refusal::Gone))?
    }

    /// Starts a turn, delivering every frame of it to the sink handed in.
    ///
    /// The answer resolves to the stop reason the agent reported once the turn
    /// is over. Every frame of the turn reaches the caller through the
    /// sink long before that, which is what the interface consumes.
    ///
    /// 一条会话同时只走一轮，那是它的记录槽的规矩；别的会话不受影响。
    pub fn prompt(
        &self,
        session_id: String,
        text: String,
        images: Vec<PromptImage>,
        frames: FrameSink,
    ) -> Result<oneshot::Receiver<Result<String>>> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::Prompt {
            session_id,
            text,
            images,
            frames,
            reply,
        })?;

        Ok(answer)
    }

    /// Asks the agent to stop the turn in flight on one session.
    ///
    /// Cancellation is cooperative: the agent may still finish normally, and
    /// the turn's own answer reports which of the two happened.
    ///
    /// 停哪一条必须说出来。一条连接上有多条会话，而它们可以同时在飞。
    /// 凭证只从握手来（`Handshake::cancelling`）。
    pub fn cancel(&self, _granted: CanCancelSession, session_id: String) -> Result<()> {
        self.send(Command::Cancel { session_id })
    }

    /// Ends every session and lets the agent process exit.
    pub fn shutdown(&self) -> Result<()> {
        self.send(Command::Shutdown)
    }

    /// Asks which selectors the session is offering.
    ///
    /// The list is whatever the agent reported. This crate never adds a
    /// model, a reasoning level or a mode of its own.
    pub fn selectors(
        &self,
        session_id: String,
    ) -> Result<oneshot::Receiver<Result<Vec<ConfigControl>>>> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::Selectors { session_id, reply })?;

        Ok(answer)
    }

    /// Changes one selector to one of the values it offered.
    ///
    /// The answer is the whole list again, because changing one selector
    /// may add or remove another: a model with no reasoning levels takes
    /// that selector away with it.
    pub fn select(
        &self,
        session_id: String,
        config_id: String,
        value: String,
    ) -> Result<oneshot::Receiver<Result<Vec<ConfigControl>>>> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::Select {
            session_id,
            config_id,
            value,
            reply,
        })?;

        Ok(answer)
    }

    fn send(&self, command: Command) -> Result<()> {
        self.commands
            .unbounded_send(command)
            .map_err(|_disconnected| AcpError::Refused(Refusal::Gone))
    }
}
