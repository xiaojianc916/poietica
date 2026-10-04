use std::fmt;
use std::path::PathBuf;

use futures::channel::{mpsc, oneshot};

use super::config::{ConfigControl, GoalSnapshot};
use super::{
    BrowserSettings, Capability, McpServer, OpenedSession, QueuedState, Skill, WithdrawnMessage,
};
use crate::error::{AgentError, Refusal, Result};
use crate::recorder::FrameSink;
use crate::settings::{SettingEntry, SettingsCatalog};
use crate::wire::DeliverAs;
use crate::{ModelCatalogOperation, ModelCatalogSnapshot};

/// 随一句话带上的一个附件：路径、类别、内容类型、显示名。与 wire.rs 的 WireAttachment
/// 同形，这里已经是线上形状，不再折一次。
///
/// 图片也只能交路径：omp 的 SDK 收图只有 base64 一条路（`PromptOptions.images:
/// ImageContent[]`，src/session/agent-session-types.ts:345-349），没有按路径收附件的
/// API —— 读盘与编码由桥照它自己 CLI 的做法补上（src/cli/file-processor.ts:104-129）。
/// `kind` 是桥那一侧唯一的分派判据；`mime` 是进门的内容判据（`crates/asset/src/formats.rs`
/// 的 `classify()` 按文件头嗅出）与 `ImageContent.mimeType` 的唯一来源：扩展名不是判据
/// —— 粘贴的图叫 `pasted-<uuid>`，按扩展名反推会把好图说成 `application/octet-stream`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptAttachment {
    pub path: PathBuf,
    pub kind: PromptAttachmentKind,
    pub mime: String,
    pub name: String,
}

/// 附件的两类。`File` 与 `Image` 在线上只差这一个判别式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptAttachmentKind {
    Image,
    File,
}

impl PromptAttachmentKind {
    /// 线上那一格：与 protocol.ts 的 `'image' | 'file'` 逐字对应。
    #[must_use]
    pub const fn as_wire_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::File => "file",
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
/// 桥做不到的那些（目录编辑、历史读、媒体、能力安装、撤回排队）**不在这里**：
/// 它们的公开方法在 `AgentClient` 上直接答「这个 agent 还不支持」，不占一条
/// 永远不会被应答的管道命令。界面那一整套照旧（ADR 0016 后果第 5 条）。
pub(crate) enum Command {
    /// 这条连接上那一条会话。桥的形态是一条连接一条会话（握手时开好），
    /// 所以这条命令不出进程 —— 语义细节见 new_session。
    CurrentSession {
        reply: oneshot::Sender<Result<OpenedSession>>,
    },
    Prompt {
        text: String,
        /// 与 text 同属一句话：只挑图没打字也是完整的话，判空在桌面 seam 两格一起看。
        attachments: Vec<PromptAttachment>,
        skills: Vec<PromptSkill>,
        /// 这一句怎么进 agent；只有 `Turn` 会开一轮，其余三层是插话。
        deliver_as: DeliverAs,
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
    /// 待发队列此刻的样子。
    Queue {
        reply: oneshot::Sender<Result<QueuedState>>,
    },
    /// 撤回最后一条还排着的插话。
    Withdraw {
        reply: oneshot::Sender<Result<Option<WithdrawnMessage>>>,
    },
    /// 改队列模式；缺席的格不改，应答是改完之后那一份。
    Delivery {
        steering_mode: Option<String>,
        follow_up_mode: Option<String>,
        interrupt_mode: Option<String>,
        reply: oneshot::Sender<Result<QueuedState>>,
    },
    /// 回答一次工具授权。答复从 PermissionDesk 来，落到桥那边的 select() 上。
    AnswerPermission {
        request_id: String,
        decision: String,
        scope: Option<String>,
        reply: oneshot::Sender<Result<()>>,
    },
    /// 回答任意一个对话框：原样转发上游 extension_ui_response 的载荷。
    AnswerDialog {
        request_id: String,
        response: serde_json::Value,
        reply: oneshot::Sender<Result<()>>,
    },
    Skills {
        reply: oneshot::Sender<Result<Vec<Skill>>>,
    },
    McpServers {
        reply: oneshot::Sender<Result<Vec<McpServer>>>,
    },
    /// agent 自己那份设置目录。
    SettingsCatalog {
        reply: oneshot::Sender<Result<SettingsCatalog>>,
    },
    /// 改一格设置；应答是**改完之后**的整份目录（改一格可能牵动别的格子）。
    SetSetting {
        path: String,
        value: serde_json::Value,
        reply: oneshot::Sender<Result<Vec<SettingEntry>>>,
    },
    /// 此刻能改的选择器。
    Selectors {
        reply: oneshot::Sender<Result<Vec<ConfigControl>>>,
    },
    /// 目标真相；桥没有目标时回 None，那是「没有」，不是「读不到」。
    Goal {
        reply: oneshot::Sender<Result<Option<GoalSnapshot>>>,
    },
    /// 打开一条会话时要的那一页正文。
    ReadTranscript {
        session_id: String,
        agent_id: String,
        before_turn: Option<String>,
        reply: oneshot::Sender<Result<serde_json::Value>>,
    },
    /// 从某个水位起的增量。
    CatchUpTranscript {
        session_id: String,
        agent_id: String,
        since_seq: i64,
        reply: oneshot::Sender<Result<serde_json::Value>>,
    },
    Select {
        config_id: String,
        value: String,
        input: Option<String>,
        reply: oneshot::Sender<Result<Vec<ConfigControl>>>,
    },
    /// 一次提交现在怎么样了。答案在本机账本里（recorder 的准入与轮终帧），
    /// 所以这条命令不出进程 —— 它只是把账本读回来。
    PromptState {
        session_id: String,
        prompt: String,
        reply: oneshot::Sender<Result<crate::session::observe::PromptObservation>>,
    },
    /// 模型目录的一次操作。
    ModelCatalog {
        operation: ModelCatalogOperation,
        reply: oneshot::Sender<Result<ModelCatalogSnapshot>>,
    },
    /// agent 自己报的能力清单。
    Capabilities {
        reply: oneshot::Sender<Result<Vec<Capability>>>,
    },
    /// 开关一项本机能力；应答是改完之后的能力清单。
    InstallCapability {
        capability_id: String,
        enabled: bool,
        reply: oneshot::Sender<Result<Vec<Capability>>>,
    },
    /// agent 的浏览器控制设置。
    BrowserSettings {
        reply: oneshot::Sender<Result<BrowserSettings>>,
    },
    /// 写浏览器控制设置；缺席的格不改。
    SetBrowserSettings {
        enabled: Option<bool>,
        headless: Option<bool>,
        relay: Option<bool>,
        cdp_url: Option<String>,
        reply: oneshot::Sender<Result<BrowserSettings>>,
    },
    /// 重装一条以前开过的会话。
    LoadSession {
        session_id: String,
        /// 这条对话记下的工作区，找会话文件要按它扫。
        cwd: PathBuf,
        reply: oneshot::Sender<Result<OpenedSession>>,
    },
    /// 从一条会话分叉出新的那条，丢掉尾部 `drop_turns` 轮；现场换会话的语义见 fork_session。
    ForkSession {
        session_id: String,
        drop_turns: u32,
        reply: oneshot::Sender<Result<OpenedSession>>,
    },
    /// 删掉一条会话。删的是 agent 自己的会话文件，本层不碰盘。
    DeleteSession {
        session_id: String,
        reply: oneshot::Sender<Result<()>>,
    },
    /// 把一条会话导成一页 HTML，写到 `destination`。
    ExportSession {
        session_id: String,
        destination: PathBuf,
        reply: oneshot::Sender<Result<()>>,
    },
    /// 把一条会话传到 agent 自己的分享服务，换回一条链接。
    ShareSession {
        session_id: String,
        reply: oneshot::Sender<Result<ShareOutcome>>,
    },
}

/// 一次分享的结果：给人点的链接，以及内容有没有被裁。
///
/// 只有这两格：agent 还会报 method / gistUrl / sealedBytes，那是它的实现细节，
/// 屏幕上没有它们的位置，本层不转发 —— 转发就得有人解释它们。
///
/// **手写 `Debug`，`url` 不出现在里面。** omp 的链接形状是 `<serverUrl>/<id>#<key>`，
/// `#` 之后那一截是解密密钥，拿到整个字符串的人就能读这份分享 —— 它是读取凭据，
/// 不是普通 URL；派生的 Debug 会把它写进任何一行日志或错误文案（AGENTS.md §5
/// 「Debug 不打载荷」：不看像不像敏感数据，看拿到它的人能多做什么）。别改回 derive。
#[derive(Clone, PartialEq, Eq)]
pub struct ShareOutcome {
    pub url: String,
    pub truncated: bool,
}

impl fmt::Debug for ShareOutcome {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ShareOutcome")
            .field("url", &"<redacted>")
            .field("truncated", &self.truncated)
            .finish()
    }
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
 * 的事。体里没有 await 是因为它们只把命令塞进管道、等应答。
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

    /// 重装一条以前开过的会话；会话号不变，文件没了应答 `Refusal::UnknownSession`。
    pub async fn load_session(&self, session_id: String, cwd: PathBuf) -> Result<OpenedSession> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::LoadSession {
            session_id,
            cwd,
            reply,
        })?;

        answer
            .await
            .map_err(|_dropped| AgentError::Refused(Refusal::Gone))?
    }

    /// 从一条会话分叉出新的那条，丢掉尾部 `drop_turns` 轮，交回**新的**会话。
    ///
    /// 分叉是一次现场换会话：agent 那边分叉完，这条连接的活会话就是新的那一条
    /// （omp 的 AgentSession#branch 落在新文件上，agent-session.ts:10060）。所以这条
    /// 命令之后，连接上的号已经换了 —— 上层要接着用交回来的这个号，旧号在新连接上
    /// 不再有效。分叉做不到时如实报错（例如源会话不是这条连接的活会话、或要丢掉的
    /// 轮次多于已有的轮次），不假装成功：一个没发生的分叉报成功就是丢对话正文。
    pub async fn fork_session(&self, session_id: String, drop_turns: u32) -> Result<OpenedSession> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::ForkSession {
            session_id,
            drop_turns,
            reply,
        })?;

        answer
            .await
            .map_err(|_dropped| AgentError::Refused(Refusal::Gone))?
    }

    /// 删掉一条会话：删的是 agent 自己的会话文件（连同它的产物目录）。
    ///
    /// 找不到会话文件按失败报 —— 上层把「没删掉」记成待回收，下次连接再试
    /// （conversation-runtime/src/disposal.rs）；报成功等于把那次回收悄悄丢掉。
    pub async fn delete_session(&self, session_id: String) -> Result<()> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::DeleteSession { session_id, reply })?;

        answer
            .await
            .map_err(|_dropped| AgentError::Refused(Refusal::Gone))?
    }

    /// 把一条会话导成一页 HTML，写到 `destination`。
    ///
    /// 字节由 agent 自己写盘（它那份导出器自己落文件），本层只给路径 —— 所以这里
    /// 不做原子写、也不碰目标文件：两处各写一次就是两份字节。
    pub async fn export_session(&self, session_id: String, destination: PathBuf) -> Result<()> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::ExportSession {
            session_id,
            destination,
            reply,
        })?;

        answer
            .await
            .map_err(|_dropped| AgentError::Refused(Refusal::Gone))?
    }

    /// 把一条会话传到 agent 自己的分享服务，交回链接与「有没有被裁」。
    ///
    /// 会话号可能不是这条连接上活着的那一条：桥按号另开管理器（protocol.ts 的
    /// share_session），所以这里不必先把它装载起来。
    ///
    /// 应答缺格按失败上报，不猜默认：`truncated` 猜成 false 就是在说「内容完整」，
    /// 而那句话会让用户以为发出去的是全部。
    pub async fn share_session(&self, session_id: String) -> Result<ShareOutcome> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::ShareSession { session_id, reply })?;

        answer
            .await
            .map_err(|_dropped| AgentError::Refused(Refusal::Gone))?
    }

    /// 读取目标真相；未启用是 Ok(None)，连接故障是 Err。
    pub async fn goal(&self, _session_id: String) -> Result<Option<GoalSnapshot>> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::Goal { reply })?;

        answer
            .await
            .map_err(|_dropped| AgentError::Refused(Refusal::Gone))?
    }

    /// 打开一条会话时要的那一页正文：基线。
    ///
    /// 正文平时是推的（transcript 事件），这一条只服务「刚打开」——没有它，一条
    /// 已经有内容的会话在屏幕上就是空的。
    pub async fn read_transcript(
        &self,
        session_id: String,
        agent_id: String,
        before_turn: Option<String>,
    ) -> Result<serde_json::Value> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::ReadTranscript {
            session_id,
            agent_id,
            before_turn,
            reply,
        })?;

        answer
            .await
            .map_err(|_dropped| AgentError::Refused(Refusal::Gone))?
    }

    /// 断流后从某个水位追赶：只补缺的那几批，不重读整页。
    pub async fn catch_up_transcript(
        &self,
        session_id: String,
        agent_id: String,
        since_seq: i64,
    ) -> Result<serde_json::Value> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::CatchUpTranscript {
            session_id,
            agent_id,
            since_seq,
            reply,
        })?;

        answer
            .await
            .map_err(|_dropped| AgentError::Refused(Refusal::Gone))?
    }

    /// 取 agent 侧会话媒体（历史图片）的字节；连接带着鉴权，webview 自己取不到。
    pub async fn read_media(&self, _session_id: String, _file_id: String) -> Result<MediaBytes> {
        Err(unwired("reading session media"))
    }

    /// 提交一到手就回幂等键（不是停止原因）；帧走 sink，轮终走 turn_end 事件。
    ///
    /// `deliver_as` 只有 `Turn` 会开一轮；另外三层是插话，回执同样是幂等键 ——
    /// 插话的「受理」是 agent 收下（上游三个调用都返回 void），由桥 await 出来。
    pub fn prompt(
        &self,
        _session_id: String,
        text: String,
        attachments: Vec<PromptAttachment>,
        skills: Vec<PromptSkill>,
        deliver_as: DeliverAs,
        idempotency: String,
        frames: FrameSink,
    ) -> Result<oneshot::Receiver<Result<String>>> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::Prompt {
            text,
            attachments,
            skills,
            deliver_as,
            idempotency,
            frames,
            reply,
        })?;

        Ok(answer)
    }

    /// 待发队列此刻的样子：两层正文 + 三个模式。
    pub async fn queue(&self) -> Result<QueuedState> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::Queue { reply })?;

        answer
            .await
            .map_err(|_dropped| AgentError::Refused(Refusal::Gone))?
    }

    /// 撤回最后一条还排着的插话；队列空着就是 `Ok(None)`（不是错）。
    pub async fn withdraw(&self) -> Result<Option<WithdrawnMessage>> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::Withdraw { reply })?;

        answer
            .await
            .map_err(|_dropped| AgentError::Refused(Refusal::Gone))?
    }

    /// 改一到三格队列模式；应答是改完之后那一份队列。
    pub async fn set_delivery_modes(
        &self,
        steering_mode: Option<String>,
        follow_up_mode: Option<String>,
        interrupt_mode: Option<String>,
    ) -> Result<QueuedState> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::Delivery {
            steering_mode,
            follow_up_mode,
            interrupt_mode,
            reply,
        })?;

        answer
            .await
            .map_err(|_dropped| AgentError::Refused(Refusal::Gone))?
    }

    /// 把一次授权答复送到卡住的那次工具调用上。
    ///
    /// 答复不落本机账 —— 那是 `permission_resolved` 帧的事（recorder 记它），
    /// 这条命令只负责把人的决定交回给 agent。
    pub async fn answer_permission(
        &self,
        request_id: String,
        decision: String,
        scope: Option<String>,
    ) -> Result<()> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::AnswerPermission {
            request_id,
            decision,
            scope,
            reply,
        })?;

        answer
            .await
            .map_err(|_dropped| AgentError::Refused(Refusal::Gone))?
    }

    /// 回答别的对话框：载荷原样转发，本层不解释。
    pub async fn answer_dialog(
        &self,
        request_id: String,
        response: serde_json::Value,
    ) -> Result<()> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::AnswerDialog {
            request_id,
            response,
            reply,
        })?;

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
        input: Option<String>,
    ) -> Result<oneshot::Receiver<Result<Vec<ConfigControl>>>> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::Select {
            config_id,
            value,
            input,
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

    /// agent 自己那份设置目录：栏与格子都是它自报的，本层不添不减。
    pub async fn settings_catalog(&self) -> Result<SettingsCatalog> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::SettingsCatalog { reply })?;

        answer
            .await
            .map_err(|_dropped| AgentError::Refused(Refusal::Gone))?
    }

    /// 改一格设置，交回**改完之后**的整份目录。
    ///
    /// 写的是 agent 自己的持久层（它自己热重载），本层不碰它的 config 文件。
    /// `value` 原样转发：类型由它的 schema 说了算，这一侧不折算（折算就是第二份类型表）。
    pub async fn set_setting(
        &self,
        path: String,
        value: serde_json::Value,
    ) -> Result<Vec<SettingEntry>> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::SetSetting { path, value, reply })?;

        answer
            .await
            .map_err(|_dropped| AgentError::Refused(Refusal::Gone))?
    }

    /// agent 自己报的能力清单；本 crate 不添不减。
    pub async fn capabilities(&self) -> Result<Vec<Capability>> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::Capabilities { reply })?;

        answer
            .await
            .map_err(|_dropped| AgentError::Refused(Refusal::Gone))?
    }

    /// agent 的浏览器控制设置（开关、有头无头、CDP 附着）。
    pub async fn browser_settings(&self) -> Result<BrowserSettings> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::BrowserSettings { reply })?;

        answer
            .await
            .map_err(|_dropped| AgentError::Refused(Refusal::Gone))?
    }

    /// 写浏览器控制设置；缺席的格不改，交回写完的整份。
    pub async fn set_browser_settings(
        &self,
        enabled: Option<bool>,
        headless: Option<bool>,
        relay: Option<bool>,
        cdp_url: Option<String>,
    ) -> Result<BrowserSettings> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::SetBrowserSettings {
            enabled,
            headless,
            relay,
            cdp_url,
            reply,
        })?;

        answer
            .await
            .map_err(|_dropped| AgentError::Refused(Refusal::Gone))?
    }

    /// 开关一项本机能力，交回改完之后的整份清单。
    ///
    /// 不是幂等的「安装进度」：omp 里这一项是构建期编进来的 eval 前奏，没有安装
    /// 这一步，只有开与关（桥把它收成一次持久设置写入 + 刷新系统提示词，失败即回滚）。
    /// 所以这一问的答案是「现在这份清单长什么样」，与 capability_report 同形。
    pub async fn install_capability(
        &self,
        capability_id: String,
        enabled: bool,
    ) -> Result<Vec<Capability>> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::InstallCapability {
            capability_id,
            enabled,
            reply,
        })?;

        answer
            .await
            .map_err(|_dropped| AgentError::Refused(Refusal::Gone))?
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

    /// 已经交进通道、还没被驱动器读出来的命令条数。
    ///
    /// 收摊时它和「已发上线、未应答」一起构成「已受理、未应答」的全集：收摊令可能抢在
    /// 命令被读出来之前落下，只看后者会把排着的那条当成「没事了」丢掉 —— 而它的应答槽
    /// 就攥在命令里，丢掉就是受理了却不给答复。
    pub(crate) fn queued(&self) -> usize {
        self.commands.len()
    }

    fn send(&self, command: Command) -> Result<()> {
        self.commands
            .unbounded_send(command)
            .map_err(|_disconnected| AgentError::Refused(Refusal::Gone))
    }
}
