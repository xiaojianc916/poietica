//! 这条连接公布的技能与 MCP 名册。
//!
//! 两张表一次问回，按点名的那条对话回答：kap 按会话答复名册，问锚会话、把
//! 结果记到另一条对话头上，屏幕就会出现那条对话根本调不动的技能。thread_id
//! 缺席（入口那一格还没有对话）才回落到连接自带的锚会话。

use poietica_kap_client::{McpServer, McpStatus, Skill};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, State};

use super::AgentCommandResult;
use super::addressing::session_for;
use super::dto::AgentLaunch;
use super::failure::translate;
use super::runtime::{AgentRuntime, ensure_session};
use crate::local_index::LocalIndex;

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum AgentMcpStatus {
    Connected,
    Connecting,
    Disconnected,
    Error,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentMcpServer {
    pub id: String,
    pub name: String,
    pub status: AgentMcpStatus,
    pub tool_count: u32,
    pub last_error: Option<String>,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkill {
    pub name: String,
    pub description: String,
    pub source: String,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolkit {
    pub skills: Vec<AgentSkill>,
    pub mcp_servers: Vec<AgentMcpServer>,
}

/// 名册的请求：跟着一条对话走。
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolkitRequest {
    pub launch: AgentLaunch,
    pub cwd: Option<String>,
    /// 缺席才问连接自带的锚会话 —— 入口那一格还没有对话。
    pub thread_id: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn agent_toolkit(
    app: AppHandle,
    state: State<'_, AgentRuntime>,
    index: State<'_, LocalIndex>,
    request: AgentToolkitRequest,
) -> AgentCommandResult<AgentToolkit> {
    let live = ensure_session(&app, &state, request.launch, request.cwd).await?;

    /* 名册按会话回答，所以问的必须是这句话要发往的那一条。 */
    let addressed = match request.thread_id.as_deref() {
        Some(named) => session_for(&state, &index, &live, named).await?.session_id,
        None => live.anchor.clone(),
    };

    let skills = live.client.skills(addressed).await.map_err(translate)?;

    let servers = live.client.mcp_servers().await.map_err(translate)?;

    Ok(AgentToolkit {
        skills: skills.into_iter().map(restate_skill).collect(),
        mcp_servers: servers.into_iter().map(restate_server).collect(),
    })
}

fn restate_skill(skill: Skill) -> AgentSkill {
    AgentSkill {
        name: skill.name,
        description: skill.description,
        source: skill.source,
    }
}

fn restate_server(server: McpServer) -> AgentMcpServer {
    AgentMcpServer {
        id: server.id,
        name: server.name,
        status: match server.status {
            McpStatus::Connected => AgentMcpStatus::Connected,
            McpStatus::Connecting => AgentMcpStatus::Connecting,
            McpStatus::Disconnected => AgentMcpStatus::Disconnected,
            McpStatus::Error => AgentMcpStatus::Error,
        },
        tool_count: server.tool_count,
        last_error: server.last_error,
    }
}
