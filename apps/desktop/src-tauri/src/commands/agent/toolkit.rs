//! 这条连接公布的技能与 MCP 名册。
//!
//! 两张表一次问回，都发往连接自带的锚会话：名册属于这条连接，不属于任何一条
//! 对话，所以这里不收 session_id，也不要求已经有人开过对话。

use poietica_agent_runtime_native::{McpServer, McpStatus, Skill};
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, State};

use super::AgentCommandResult;
use super::dto::AgentCapabilitiesRequest;
use super::failure::translate;
use super::runtime::{AgentRuntime, ensure_session};

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

#[tauri::command]
#[specta::specta]
pub async fn agent_toolkit(
    app: AppHandle,
    state: State<'_, AgentRuntime>,
    request: AgentCapabilitiesRequest,
) -> AgentCommandResult<AgentToolkit> {
    let live = ensure_session(&app, &state, request.launch, request.cwd).await?;

    let skills = live
        .client
        .skills(live.anchor.clone())
        .await
        .map_err(translate)?;

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
