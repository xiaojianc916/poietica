pub(crate) mod book;
pub(crate) mod client;
pub(crate) mod config;
pub(crate) mod driver;
pub(crate) mod export;
pub(crate) mod reconcile;
pub(crate) mod reconnect;
pub(crate) mod rest;
pub(crate) mod router;
pub(crate) mod selection;
mod tasks;

pub use book::SessionBook;
pub use client::{AgentClient, MediaBytes, PromptAttachment, PromptSkill};
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

#[derive(Clone, Debug)]
pub struct AgentSpawn {
    pub program: String,
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
    Cursor {
        session_id: String,
        cursor: Cursor,
    },
    CursorLost {
        session_id: String,
    },

    Transcript {
        session_id: String,
        payload: serde_json::Value,
    },
    ModelCatalogChanged,
    Link(poietica_conversation::link::LinkState),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SessionUsageSnapshot {
    pub used: u64,
    pub size: u64,
    pub input_other: u64,
    pub input_cache_read: u64,
    pub input_cache_creation: u64,
}

/// 位置由 server 签发（信封 seq，跨守护进程重启有效）；重新订阅原样报回去，server 才知道从哪帧接着发（contracts/kap/asyncapi.json 的 subscribe 载荷）。
pub use crate::connection::cursor::Cursor;

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
