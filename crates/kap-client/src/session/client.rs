use std::fmt;
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};

use futures::channel::{mpsc, oneshot};

use super::config::{ConfigControl, GoalSnapshot};
use super::{Capability, Cursor, McpServer, OpenedSession, SessionEntry, Skill};
use crate::error::{KapError, Refusal, Result};
use crate::recorder::FrameSink;
use crate::{ModelCatalogOperation, ModelCatalogSnapshot};

pub enum PromptAttachment {
    Image {
        data: String,
        mime_type: String,
        url: String,
    },
    Text {
        text: String,
        url: String,
    },
}

impl PromptAttachment {
    #[must_use]
    pub fn url(&self) -> &str {
        match self {
            Self::Image { url, .. } | Self::Text { url, .. } => url,
        }
    }
}

impl fmt::Debug for PromptAttachment {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Image {
                data,
                mime_type,
                url,
            } => formatter
                .debug_struct("PromptAttachment::Image")
                .field("mime_type", mime_type)
                .field("base64_len", &data.len())
                .field("url", url)
                .finish(),
            Self::Text { text, url } => formatter
                .debug_struct("PromptAttachment::Text")
                .field("text_len", &text.len())
                .field("url", url)
                .finish(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct PromptSkill {
    pub name: String,
    pub args: Option<String>,
}

pub(crate) enum Command {
    NewSession {
        cwd: PathBuf,
        reply: oneshot::Sender<Result<OpenedSession>>,
    },
    /// 装回一条以前开过的会话：kap 的会话在 server 侧持久，load_session 验存在并重订阅，历史还在 agent 手里。
    LoadSession {
        session_id: String,
        from: Option<Cursor>,
        reply: oneshot::Sender<Result<OpenedSession>>,
    },
    /// 分叉出一条新会话：kap 的 :fork 复制整条、:undo 收到分叉点，源会话原样不动。
    ForkSession {
        session_id: String,
        drop_turns: u32,
        reply: oneshot::Sender<Result<OpenedSession>>,
    },
    /// 删除由 kap 的 :archive 承接（无硬删除），agent 那侧存着对话全文。
    DeleteSession {
        session_id: String,
        reply: oneshot::Sender<Result<()>>,
    },
    Sessions {
        reply: oneshot::Sender<Result<Vec<SessionEntry>>>,
    },
    ExportSession {
        session_id: String,
        destination: PathBuf,
        reply: oneshot::Sender<Result<()>>,
    },
    Skills {
        session_id: String,
        reply: oneshot::Sender<Result<Vec<Skill>>>,
    },
    McpServers {
        reply: oneshot::Sender<Result<Vec<McpServer>>>,
    },
    Capabilities {
        reply: oneshot::Sender<Result<Vec<Capability>>>,
    },
    InstallCapability {
        capability_id: String,
        reply: oneshot::Sender<Result<Capability>>,
    },
    Prompt {
        session_id: String,
        text: String,
        /// 与 text 同属一句话：只挑图没打字也是完整的话，判空在桌面 seam 两格一起看。
        attachments: Vec<PromptAttachment>,
        skills: Vec<PromptSkill>,
        /// 幂等键：快照的 SubmitPromptRequest.prompt_id，重试投递时 server 收过不重复入列。
        idempotency: String,
        frames: FrameSink,
        reply: oneshot::Sender<Result<String>>,
    },
    /// 停掉这条会话上正在飞的那一轮，只停它。
    Cancel {
        session_id: String,
        reply: oneshot::Sender<Result<()>>,
    },
    /// 把排队的那几句并进正在跑的那一轮（kap 的 prompts:steer）。
    Steer {
        session_id: String,
        prompt_ids: Vec<String>,
        reply: oneshot::Sender<Result<()>>,
    },
    /// 撤掉一条还在排队的提问（kap 的 prompts/{id}:abort）。
    AbortPrompt {
        session_id: String,
        prompt_id: String,
        reply: oneshot::Sender<Result<()>>,
    },

    ModelCatalog {
        operation: ModelCatalogOperation,
        reply: oneshot::Sender<Result<ModelCatalogSnapshot>>,
    },
    /// 退场：杀掉这条连接起的进程，杀完从收据上报一声。
    Shutdown(SyncSender<()>),
    Selectors {
        session_id: String,
        reply: oneshot::Sender<Result<Vec<ConfigControl>>>,
    },
    Select {
        session_id: String,
        config_id: String,
        value: String,
        input: Option<String>,
        reply: oneshot::Sender<Result<Vec<ConfigControl>>>,
    },
    Goal {
        session_id: String,
        reply: oneshot::Sender<Result<Option<GoalSnapshot>>>,
    },
    /// 一个 agent 的 transcript 页，原样 JSON（契约钉在 vendored @poietica/transcript 的 schema）。
    ReadTranscript {
        session_id: String,
        agent_id: String,
        before_turn: Option<String>,
        reply: oneshot::Sender<Result<serde_json::Value>>,
    },
    /// 一个 agent 的 transcript 追赶批次（REST transcript/ops）。
    CatchUpTranscript {
        session_id: String,
        agent_id: String,
        since_seq: i64,
        reply: oneshot::Sender<Result<serde_json::Value>>,
    },
}

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
    pub(crate) const fn new(commands: mpsc::UnboundedSender<Command>) -> Self {
        Self { commands }
    }

    pub async fn new_session(&self, cwd: PathBuf) -> Result<OpenedSession> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::NewSession { cwd, reply })?;

        answer
            .await
            .map_err(|_dropped| KapError::Refused(Refusal::Gone))?
    }

    /// 重装一条以前开过的会话；读点一起交回去，server 从那一帧之后接着发。
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

    pub async fn delete_session(&self, session_id: String) -> Result<()> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::DeleteSession { session_id, reply })?;

        answer
            .await
            .map_err(|_dropped| KapError::Refused(Refusal::Gone))?
    }

    /// 标题是 agent 自己的，唯一诚实的来源；未命名的会话不报标题。
    pub async fn sessions(&self) -> Result<Vec<SessionEntry>> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::Sessions { reply })?;

        answer
            .await
            .map_err(|_dropped| KapError::Refused(Refusal::Gone))?
    }

    pub async fn export_session(&self, session_id: String, destination: PathBuf) -> Result<()> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::ExportSession {
            session_id,
            destination,
            reply,
        })?;

        answer
            .await
            .map_err(|_dropped| KapError::Refused(Refusal::Gone))?
    }

    /// 读取目标真相；未启用是 Ok(None)，连接故障是 Err。
    pub async fn goal(&self, session_id: String) -> Result<Option<GoalSnapshot>> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::Goal { session_id, reply })?;

        answer
            .await
            .map_err(|_dropped| KapError::Refused(Refusal::Gone))?
    }

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
            .map_err(|_dropped| KapError::Refused(Refusal::Gone))?
    }

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
            .map_err(|_dropped| KapError::Refused(Refusal::Gone))?
    }

    /// 提交一到手就回 prompt id（不是停止原因）；帧走 sink，运行中再提交由 kap 排队。
    pub fn prompt(
        &self,
        session_id: String,
        text: String,
        attachments: Vec<PromptAttachment>,
        skills: Vec<PromptSkill>,
        idempotency: String,
        frames: FrameSink,
    ) -> Result<oneshot::Receiver<Result<String>>> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::Prompt {
            session_id,
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
    pub async fn steer(&self, session_id: String, prompt_ids: Vec<String>) -> Result<()> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::Steer {
            session_id,
            prompt_ids,
            reply,
        })?;

        answer
            .await
            .map_err(|_dropped| KapError::Refused(Refusal::Gone))?
    }

    /// 撤掉一条还在排队的提问，在跑的那一轮一个字不动。
    pub async fn abort_prompt(&self, session_id: String, prompt_id: String) -> Result<()> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::AbortPrompt {
            session_id,
            prompt_id,
            reply,
        })?;

        answer
            .await
            .map_err(|_dropped| KapError::Refused(Refusal::Gone))?
    }

    /// 取消是协作式的：agent 也可能刚好正常跑完，轮终帧会报是哪一种。
    pub async fn cancel(&self, session_id: String) -> Result<()> {
        let (reply, answer) = oneshot::channel();
        self.send(Command::Cancel { session_id, reply })?;
        answer
            .await
            .map_err(|_dropped| KapError::Refused(Refusal::Gone))?
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
        session_id: String,
    ) -> Result<oneshot::Receiver<Result<Vec<ConfigControl>>>> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::Selectors { session_id, reply })?;

        Ok(answer)
    }

    /// 回交整份清单：改一个选择器可能增删另一个。
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

    /// 本地不扫盘：技能目录的合并与覆盖规则归上游。
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

    pub async fn capabilities(&self) -> Result<Vec<Capability>> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::Capabilities { reply })?;

        answer
            .await
            .map_err(|_dropped| KapError::Refused(Refusal::Gone))?
    }

    /// 幂等，交回它此刻的进度。
    pub async fn install_capability(&self, capability_id: String) -> Result<Capability> {
        let (reply, answer) = oneshot::channel();

        self.send(Command::InstallCapability {
            capability_id,
            reply,
        })?;

        answer
            .await
            .map_err(|_dropped| KapError::Refused(Refusal::Gone))?
    }

    pub async fn model_catalog(
        &self,
        operation: ModelCatalogOperation,
    ) -> Result<ModelCatalogSnapshot> {
        let (reply, answer) = oneshot::channel();
        self.send(Command::ModelCatalog { operation, reply })?;
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
