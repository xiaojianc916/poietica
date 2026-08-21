//! Kimi 检测到的 MCP server 名册。

use poietica_agent_runtime_native::{McpServer, McpStatus, McpTransport};
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, State};

use super::dto::AgentCapabilitiesRequest;
use super::failure::translate;
use super::runtime::{AgentRuntime, ensure_session};
use super::AgentCommandResult;

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum AgentMcpTransport {
    Stdio,
    Http,
    Sse,
}

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
    pub transport: AgentMcpTransport,
    pub status: AgentMcpStatus,
    pub tool_count: u32,
    pub last_error: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn agent_mcp_servers(
    app: AppHandle,
    state: State<'_, AgentRuntime>,
    request: AgentCapabilitiesRequest,
) -> AgentCommandResult<Vec<AgentMcpServer>> {
    let live = ensure_session(&app, &state, request.launch, request.cwd).await?;
    let listed = live.client.mcp_servers().await.map_err(translate)?;
    Ok(listed.into_iter().map(restate).collect())
}

fn restate(server: McpServer) -> AgentMcpServer {
    AgentMcpServer {
        id: server.id,
        name: server.name,
        transport: match server.transport {
            McpTransport::Stdio => AgentMcpTransport::Stdio,
            McpTransport::Http => AgentMcpTransport::Http,
            McpTransport::Sse => AgentMcpTransport::Sse,
        },
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
