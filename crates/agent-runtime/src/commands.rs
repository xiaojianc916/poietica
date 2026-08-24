use std::fmt;
use std::path::PathBuf;

use futures::channel::{mpsc, oneshot};

use crate::config::{ConfigControl, GoalSnapshot};
use crate::error::{KapError, Refusal, Result};
use crate::recorder::FrameSink;
use crate::session::{Cursor, McpServer, OpenedSession, SessionEntry, Skill};

/// 这一轮随那句话一起送出去的一张图片。
///
/// base64 是协议自己的形状：kap 的 image content block 就是 media_type 加
/// base64 的 data（protocol/message.ts 的 imageContentSchema），所以这一格
/// 原样进请求体，中间不解码。
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

#[derive(Clone, Debug)]
pub struct PromptSkill {
    pub name: String,
    pub args: Option<String>,
}

/// What the driver is asked to do next.
///
/// 每一条都是一件事，而不是一个时段：驱动器把它变成一个自己的未来推进去，
/// 谁先回来谁先落账 —— 「正在等一个回应」不该成为拒绝其他命令的理由。
pub(crate) enum Command {
    /// Open one more session on the connection that is already running.
    NewSession {
        cwd: PathBuf,
        reply: oneshot::Sender<Result<OpenedSession>>,
    },
    /// 把一条以前开过的会话装回本次连接。
    ///
    /// 会话号是上一次运行存下来的。kap 的会话在 server 侧持久，装载就是
    /// 验存在并重新订阅（load_session）：装载之后这条会话仍然是它自己，
    /// 历史因此还在 agent 手里 —— 与新开一条的分别在于上下文还在不在。
    LoadSession {
        session_id: String,
        /// 上一次这条会话的事件流读到哪儿了；没读过就是空。
        from: Option<Cursor>,
        reply: oneshot::Sender<Result<OpenedSession>>,
    },
    /// 让 agent 从一条已有会话的某一轮分叉出一条新会话。
    ///
    /// 历史归 agent 所有，本地只有索引，所以这只能是协议动作：kap 的 :fork
    /// 复制整条，:undo 把复制件收到分叉点。源会话原样不动。
    ForkSession {
        session_id: String,
        /// 复制件上再回退几轮；0 就是整条带走。
        drop_turns: u32,
        reply: oneshot::Sender<Result<OpenedSession>>,
    },
    /// 让 agent 删掉一条它自己存着的会话。
    ///
    /// 删除对话不是本地的事：agent 那侧存着同一条对话的全文。kap 没有
    /// 硬删除，删除由 :archive 承接。
    DeleteSession {
        session_id: String,
        reply: oneshot::Sender<Result<()>>,
    },
    /// Ask the agent which sessions it keeps, and what it calls them.
    Sessions {
        reply: oneshot::Sender<Result<Vec<SessionEntry>>>,
    },
    /// 这条会话能用的技能。
    Skills {
        session_id: String,
        reply: oneshot::Sender<Result<Vec<Skill>>>,
    },
    /// Kimi 当前进程检测到的 MCP server。
    McpServers {
        reply: oneshot::Sender<Result<Vec<McpServer>>>,
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
        /// 与正文、附件同一次提交的 Skill。
        skills: Vec<PromptSkill>,
        /// 这条会话的帧交到哪里去。记录器由驱动器造：序号线在它的槽里。
        frames: FrameSink,
        /// kap 收下这句话时给的 prompt id。
        reply: oneshot::Sender<Result<String>>,
    },
    /// 停掉这条会话上正在飞的那一轮，只停它。
    ///
    /// 一条连接同时开着多条会话，而现在它们可以同时在飞：不点名的取消
    /// 停掉的会是别人那一轮。
    Cancel {
        session_id: String,
        reply: oneshot::Sender<Result<()>>,
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
        input: Option<String>,
        reply: oneshot::Sender<Result<Vec<ConfigControl>>>,
    },
    /// 这条会话此刻的目标；没有目标在跑交 None。
    Goal {
        session_id: String,
        reply: oneshot::Sender<Option<GoalSnapshot>>,
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
    pub async fn new_session(&self, cwd: PathBuf) -> Result<OpenedSession> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::NewSession { cwd, reply })?;

        answer
            .await
            .map_err(|_dropped| KapError::Refused(Refusal::Gone))?
    }

    /// Reloads a session this agent opened in an earlier run.
    ///
    /// 会话号原样交回去，agent 那侧把它重新装载起来，历史因此还在。
    ///
    /// 读点一起交回去：订阅时报得出上一次读到哪儿，server 才从那一帧之后接着发。
    ///
    /// # Errors
    ///
    /// Fails when the connection is gone, or when the agent no longer keeps
    /// that session.
    pub async fn load_session(
        &self,
        session_id: String,
        from: Option<Cursor>,
    ) -> Result<OpenedSession> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::LoadSession {
            session_id,
            from,
            reply,
        })?;

        answer
            .await
            .map_err(|_dropped| KapError::Refused(Refusal::Gone))?
    }

    /// Forks a session the agent keeps into a new, independent one.
    ///
    /// 号与分叉点一起交过去：agent 复制整条再回退 drop_turns 轮，交回新会话
    /// —— 源会话原样不动。
    ///
    /// # Errors
    ///
    /// Fails when the connection is gone, or when the agent refuses to fork
    /// that session.
    pub async fn fork_session(&self, session_id: String, drop_turns: u32) -> Result<OpenedSession> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::ForkSession {
            session_id,
            drop_turns,
            reply,
        })?;

        answer
            .await
            .map_err(|_dropped| KapError::Refused(Refusal::Gone))?
    }

    /// Asks the agent to delete one of the sessions it keeps.
    ///
    /// 号删掉之后它不再指向任何东西：驱动器会同时把它从选择器表和会话册子里抹掉。
    ///
    /// # Errors
    ///
    /// Fails when the connection is gone, or when the agent refuses to
    /// delete that session.
    pub async fn delete_session(&self, session_id: String) -> Result<()> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::DeleteSession { session_id, reply })?;

        answer
            .await
            .map_err(|_dropped| KapError::Refused(Refusal::Gone))?
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
            .map_err(|_dropped| KapError::Refused(Refusal::Gone))?
    }

    /// 这条会话此刻的目标。连接不在了也答 None —— 这一格的读者是屏幕上
    /// 一枚岛，缺席即不画，不值得为此造一个错误面。
    pub async fn goal(&self, session_id: String) -> Option<GoalSnapshot> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::Goal { session_id, reply }).ok()?;

        answer.await.ok()?
    }

    /// Starts a turn, delivering every frame of it to the sink handed in.
    ///
    /// 答复是 kap 收下这句话时给的 prompt id，不是这一轮的停止原因：提交一到
    /// 手就回，帧走 sink。运行中再提交一句由 kap 排队，本机不拦。
    pub fn prompt(
        &self,
        session_id: String,
        text: String,
        images: Vec<PromptImage>,
        skills: Vec<PromptSkill>,
        frames: FrameSink,
    ) -> Result<oneshot::Receiver<Result<String>>> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::Prompt {
            session_id,
            text,
            images,
            skills,
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
    pub async fn cancel(&self, session_id: String) -> Result<()> {
        let (reply, answer) = oneshot::channel();
        self.send(Command::Cancel { session_id, reply })?;
        answer
            .await
            .map_err(|_dropped| KapError::Refused(Refusal::Gone))?
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
        input: Option<String>,
    ) -> Result<oneshot::Receiver<Result<Vec<ConfigControl>>>> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::Select {
            session_id,
            config_id,
            value,
            input,
            reply,
        })?;

        Ok(answer)
    }

    /// Asks which skills that session can use.
    ///
    /// 本地不扫盘：四层技能目录的合并与覆盖规则归上游。
    ///
    /// # Errors
    ///
    /// Fails when the connection is gone, or when the agent refuses to list.
    pub async fn skills(&self, session_id: String) -> Result<Vec<Skill>> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::Skills { session_id, reply })?;

        answer
            .await
            .map_err(|_dropped| KapError::Refused(Refusal::Gone))?
    }

    pub async fn mcp_servers(&self) -> Result<Vec<McpServer>> {
        let (reply, answer) = oneshot::channel();
        self.send(Command::McpServers { reply })?;
        answer
            .await
            .map_err(|_dropped| KapError::Refused(Refusal::Gone))?
    }

    fn send(&self, command: Command) -> Result<()> {
        self.commands
            .unbounded_send(command)
            .map_err(|_disconnected| KapError::Refused(Refusal::Gone))
    }
}
