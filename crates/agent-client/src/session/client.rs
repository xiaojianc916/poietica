use std::fmt;
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};

use futures::channel::{mpsc, oneshot};

use super::config::{ConfigControl, GoalSnapshot};
use super::{Capability, Cursor, McpServer, OpenedSession, SessionEntry, Skill};
use crate::error::{AgentError, Refusal, Result};
use crate::recorder::FrameSink;
use crate::{ModelCatalogOperation, ModelCatalogSnapshot};

/// 一个附件怎么交给 agent。
///
/// 两条路都是「磁盘绝对路径 + 元数据」：图片与通用文件在线上是不同的 content part
/// （`image` 对 `file`），但字节一律不拍平进提示正文，也一律不内联 base64。
/// 图片走路径才会被 agent 收进会话媒体库，气泡也才拿得到它（见 ADR 0050）。
pub enum PromptAttachment {
    Image {
        path: PathBuf,
        name: String,
    },
    /// 通用文件：只给 agent 一个磁盘路径与元数据，它经 Read 工具按需打开。
    File {
        path: PathBuf,
        name: String,
        mime_type: String,
        size: i64,
    },
}

impl fmt::Debug for PromptAttachment {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Image { name, .. } => formatter
                .debug_struct("PromptAttachment::Image")
                .field("name", name)
                .finish_non_exhaustive(),
            Self::File {
                name,
                mime_type,
                size,
                ..
            } => formatter
                .debug_struct("PromptAttachment::File")
                .field("name", name)
                .field("mime_type", mime_type)
                .field("size", size)
                .finish_non_exhaustive(),
        }
    }
}

/// agent transcript 里会话媒体的图片字节：webview 无法带鉴权头直连，
/// 由这条连接取回转给渲染层。Debug 不打字节。
pub struct MediaBytes {
    pub content_type: String,
    pub bytes: Vec<u8>,
}

impl fmt::Debug for MediaBytes {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MediaBytes")
            .field("content_type", &self.content_type)
            .field("byte_len", &self.bytes.len())
            .finish()
    }
}

#[derive(Clone, Debug)]
pub struct PromptSkill {
    pub name: String,
    pub args: Option<String>,
}

/// 进管道的命令：桥真的会做的那几条。
///
/// 桥做不到的那些（装载、分叉、导出、目录编辑、历史读、媒体）**不在这里**：
/// 它们的公开方法在 `AgentClient` 上直接答「这个 agent 还不支持」，不占一条
/// 永远不会被应答的管道命令。界面那一整套照旧（ADR 0052 后果第 5 条）。
pub(crate) enum Command {
    /// 这条连接上那一条会话。
    ///
    /// 桥的形态是「一条连接一条会话」，会话在握手时就开好了 —— 所以这条命令
    /// 不出进程，它只是把那个号交回去。跨工作区的多会话要另开一条连接，
    /// 那是本层尚未接上的部分（见 ADR 0052 的待验证一节）。
    CurrentSession {
        reply: oneshot::Sender<Result<OpenedSession>>,
    },
    Prompt {
        text: String,
        /// 与 text 同属一句话：只挑图没打字也是完整的话，判空在桌面 seam 两格一起看。
        attachments: Vec<PromptAttachment>,
        skills: Vec<PromptSkill>,
        /// 幂等键：提交时给出的那一个。本机账本按它认轮（automation 用 run id），
        /// 桥那边不需要 —— 轮终由 turn_end 事件报，不靠回执对账。
        idempotency: String,
        /// 这一轮的帧日志出口。由驱动器在准入时 attach 给槽，不经管道。
        frames: FrameSink,
        reply: oneshot::Sender<Result<String>>,
    },
    /// 停掉这条会话上正在飞的那一轮，只停它。
    Cancel {
        session_id: String,
        reply: oneshot::Sender<Result<()>>,
    },
    /// 把排队的那几句并进正在跑的那一轮。
    Steer {
        prompt_ids: Vec<String>,
        reply: oneshot::Sender<Result<()>>,
    },
    Skills {
        reply: oneshot::Sender<Result<Vec<Skill>>>,
    },
    McpServers {
        reply: oneshot::Sender<Result<Vec<McpServer>>>,
    },
    /// 退场：杀掉这条连接起的进程，杀完从收据上报一声。
    Shutdown(SyncSender<()>),
    Selectors {
        reply: oneshot::Sender<Result<Vec<ConfigControl>>>,
    },
    Select {
        config_id: String,
        value: String,
        reply: oneshot::Sender<Result<Vec<ConfigControl>>>,
    },
    /// 一次提交现在怎么样了。答案在本机账本里（recorder 的准入与轮终帧），
    /// 所以这条命令不出进程 —— 它只是把账本读回来。
    PromptState {
        session_id: String,
        prompt: String,
        reply: oneshot::Sender<Result<crate::session::observe::PromptObservation>>,
    },
    /// 模型目录的一次操作。omp 那条路还没接上，所以本机答不支持。
    ModelCatalog {
        operation: ModelCatalogOperation,
        reply: oneshot::Sender<Result<ModelCatalogSnapshot>>,
    },
}

/// 「这个 agent 的这条能力还没接上」。
///
/// 一条规则、一个产地：所有未接能力的公开方法都从这里出话，文案因此一致，
/// 界面也只需认一种错。刻意不是 Transport/Refused —— 那两类会让界面以为是
/// 链路问题而重试。
fn unwired(what: &str) -> AgentError {
    AgentError::Validation {
        message: format!("{what} is not wired to this agent yet"),
    }
}

/*
 * 下面这些方法刻意留着 `async`：调用方在 `.await` 它们，签名是公开契约的一部分。
 * 改成同步会把「哪条命令走网络」这一格漏给每一个调用点，而那一格恰恰是这一层
 * 的事。体里没有 await 是因为它们现在只答「还没接」。
 */
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

#[allow(
    clippy::unused_async,
    clippy::unused_async_trait_impl,
    reason = "these are awaited by callers; the async signature is the public contract"
)]
impl AgentClient {
    pub(crate) const fn new(commands: mpsc::UnboundedSender<Command>) -> Self {
        Self { commands }
    }

    /// 这条连接上那一条会话。
    ///
    /// 桥的形态是「一条连接一条会话」：会话在握手时就按 `AgentSpawn.cwd` 开好了。
    /// 所以这里不是「再开一条」，而是把已经开好的那条交回去 —— 换工作区由上层
    /// 换一条连接（见 connection.rs 按 workspace 选连接）。多会话并发仍然成立，
    /// 只是并发的粒度是连接而不是命令。
    pub async fn new_session(&self, _cwd: PathBuf) -> Result<OpenedSession> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::CurrentSession { reply })?;

        answer
            .await
            .map_err(|_dropped| AgentError::Refused(Refusal::Gone))?
    }

    /// 重装一条以前开过的会话。
    ///
    /// 还没接：omp 的会话重装要走 `SessionManager.open`，桥只开第一条。补上之前
    /// 如实说没有，而不是假装装回来了。
    pub async fn load_session(
        &self,
        _session_id: String,
        _from: Option<Cursor>,
    ) -> Result<OpenedSession> {
        Err(unwired("restoring an earlier session"))
    }

    pub async fn fork_session(
        &self,
        _session_id: String,
        _drop_turns: u32,
    ) -> Result<OpenedSession> {
        Err(unwired("forking a session"))
    }

    pub async fn delete_session(&self, _session_id: String) -> Result<()> {
        Err(unwired("deleting a session"))
    }

    /// 标题是 agent 自己的，唯一诚实的来源；未命名的会话不报标题。
    pub async fn sessions(&self) -> Result<Vec<SessionEntry>> {
        Err(unwired("listing sessions"))
    }

    pub async fn export_session(&self, _session_id: String, _destination: PathBuf) -> Result<()> {
        Err(unwired("exporting a session"))
    }

    /// 读取目标真相；未启用是 Ok(None)，连接故障是 Err。
    pub async fn goal(&self, _session_id: String) -> Result<Option<GoalSnapshot>> {
        Err(unwired("the goal switch"))
    }

    pub async fn read_transcript(
        &self,
        _session_id: String,
        _agent_id: String,
        _before_turn: Option<String>,
    ) -> Result<serde_json::Value> {
        Err(unwired("reading the transcript over the wire"))
    }

    pub async fn catch_up_transcript(
        &self,
        _session_id: String,
        _agent_id: String,
        _since_seq: i64,
    ) -> Result<serde_json::Value> {
        Err(unwired("catching up the transcript over the wire"))
    }

    /// 取 agent 侧会话媒体（历史图片）的字节；连接带着鉴权，webview 自己取不到。
    pub async fn read_media(&self, _session_id: String, _file_id: String) -> Result<MediaBytes> {
        Err(unwired("reading session media"))
    }

    /// 提交一到手就回幂等键（不是停止原因）；帧走 sink，轮终走 turn_end 事件。
    pub fn prompt(
        &self,
        _session_id: String,
        text: String,
        attachments: Vec<PromptAttachment>,
        skills: Vec<PromptSkill>,
        idempotency: String,
        frames: FrameSink,
    ) -> Result<oneshot::Receiver<Result<String>>> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::Prompt {
            text,
            attachments,
            skills,
            idempotency,
            frames,
            reply,
        })?;

        Ok(answer)
    }

    /// 把排队的几句并进正在跑的那一轮，不中断在跑的（与 cancel 的分野）。
    pub async fn steer(&self, _session_id: String, prompt_ids: Vec<String>) -> Result<()> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::Steer { prompt_ids, reply })?;

        answer
            .await
            .map_err(|_dropped| AgentError::Refused(Refusal::Gone))?
    }

    /// 撤掉一条还在排队的提问，在跑的那一轮一个字不动。
    pub async fn abort_prompt(&self, _session_id: String, _prompt_id: String) -> Result<()> {
        Err(unwired("withdrawing a queued prompt"))
    }

    /// 取消是协作式的：agent 也可能刚好正常跑完，轮终事件会报是哪一种。
    pub async fn cancel(&self, session_id: String) -> Result<()> {
        let (reply, answer) = oneshot::channel();
        self.send(Command::Cancel { session_id, reply })?;
        answer
            .await
            .map_err(|_dropped| AgentError::Refused(Refusal::Gone))?
    }

    /// 结束这条连接，交回「它起的进程已经没了」的收据；只有退出屏障会等。
    pub fn shutdown(&self) -> Result<Receiver<()>> {
        /* 容量 1：驱动器报完就走，不为一个已经等到超时的收据挂住。 */
        let (gone, receipt) = sync_channel(1);

        self.send(Command::Shutdown(gone))?;

        Ok(receipt)
    }

    /// 清单就是 agent 报的那份：本 crate 从不自己加模型、档位或模式。
    pub fn selectors(
        &self,
        _session_id: String,
    ) -> Result<oneshot::Receiver<Result<Vec<ConfigControl>>>> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::Selectors { reply })?;

        Ok(answer)
    }

    /// 回交整份清单：改一个选择器可能增删另一个。
    pub fn select(
        &self,
        _session_id: String,
        config_id: String,
        value: String,
    ) -> Result<oneshot::Receiver<Result<Vec<ConfigControl>>>> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::Select {
            config_id,
            value,
            reply,
        })?;

        Ok(answer)
    }

    /// 本地不扫盘：技能目录的合并与覆盖规则归 agent。
    pub async fn skills(&self, _session_id: String) -> Result<Vec<Skill>> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::Skills { reply })?;

        answer
            .await
            .map_err(|_dropped| AgentError::Refused(Refusal::Gone))?
    }

    pub async fn mcp_servers(&self) -> Result<Vec<McpServer>> {
        let (reply, answer) = oneshot::channel();
        self.send(Command::McpServers { reply })?;
        answer
            .await
            .map_err(|_dropped| AgentError::Refused(Refusal::Gone))?
    }

    pub async fn capabilities(&self) -> Result<Vec<Capability>> {
        Err(unwired("the capability report"))
    }

    /// 幂等，交回它此刻的进度。
    pub async fn install_capability(&self, _capability_id: String) -> Result<Capability> {
        Err(unwired("installing a capability"))
    }

    pub async fn model_catalog(
        &self,
        operation: ModelCatalogOperation,
    ) -> Result<ModelCatalogSnapshot> {
        let (reply, answer) = oneshot::channel();
        self.send(Command::ModelCatalog { operation, reply })?;
        answer
            .await
            .map_err(|_dropped| AgentError::Refused(Refusal::Gone))?
    }

    /// 这条连接怎么看这次提交：在飞、成了、败了、撤了，或不是这条连接的事。
    pub async fn prompt_state(
        &self,
        session_id: &str,
        prompt: &str,
    ) -> Result<crate::session::observe::PromptObservation> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::PromptState {
            session_id: session_id.to_owned(),
            prompt: prompt.to_owned(),
            reply,
        })?;

        answer
            .await
            .map_err(|_dropped| AgentError::Refused(Refusal::Gone))?
    }

    fn send(&self, command: Command) -> Result<()> {
        self.commands
            .unbounded_send(command)
            .map_err(|_disconnected| AgentError::Refused(Refusal::Gone))
    }
}
