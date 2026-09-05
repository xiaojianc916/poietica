use crate::error::{Error, Result};
use axum::{
    extract::{Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::Response,
};
use poietica_automation::{AutomationCatalog, AutomationCreation, AutomationUpdate, Command};
use poietica_problem::Problem;
use rmcp::{
    handler::server::wrapper::Parameters,
    model::CallToolResult,
    tool, tool_router,
    transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService, session::never::NeverSessionManager,
    },
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::future::IntoFuture;
use std::net::TcpListener;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::thread::JoinHandle;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

const SERVER_NAME: &str = "poietica-automations";
#[derive(Clone, Debug, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpEndpoint {
    pub url: String,
}

struct Access {
    host: String,
    authorization: String,
}
impl Access {
    fn accepts(&self, headers: &HeaderMap) -> bool {
        !headers.contains_key(header::ORIGIN)
            && headers
                .get(header::HOST)
                .and_then(|value| value.to_str().ok())
                == Some(self.host.as_str())
            && headers
                .get(header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
                == Some(self.authorization.as_str())
    }
}
async fn protect(
    State(access): State<Arc<Access>>,
    request: Request,
    next: Next,
) -> std::result::Result<Response, StatusCode> {
    if !access.accepts(request.headers()) {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(next.run(request).await)
}

pub(crate) struct AutomationMcpServer {
    endpoint: McpEndpoint,
    access: Arc<Access>,
    alive: Arc<AtomicBool>,
    stopping: Mutex<Option<oneshot::Sender<()>>>,
    worker: Mutex<Option<JoinHandle<std::io::Result<()>>>>,
}
impl std::fmt::Debug for AutomationMcpServer {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AutomationMcpServer")
            .field("alive", &self.alive.load(Ordering::Acquire))
            .finish_non_exhaustive()
    }
}
impl AutomationMcpServer {
    pub(crate) fn stop(&self) -> std::io::Result<()> {
        self.alive.store(false, Ordering::Release);
        if let Some(signal) = self
            .stopping
            .lock()
            .map_err(|_| std::io::Error::other("MCP stop ownership poisoned"))?
            .take()
        {
            let _sent = signal.send(());
        }
        if let Some(worker) = self
            .worker
            .lock()
            .map_err(|_| std::io::Error::other("MCP worker ownership poisoned"))?
            .take()
        {
            worker
                .join()
                .map_err(|_| std::io::Error::other("MCP worker panicked"))??;
        }
        Ok(())
    }
    fn registration(&self) -> Result<serde_json::Value> {
        if !self.alive.load(Ordering::Acquire) {
            return Err(Error::AgentCli("自动化 MCP 服务不可用".to_owned()));
        }
        Ok(
            serde_json::json!({"url":self.endpoint.url, "headers":{"Authorization":self.access.authorization}}),
        )
    }
}
impl Drop for AutomationMcpServer {
    fn drop(&mut self) {
        if let Err(error) = self.stop() {
            log::error!("automation MCP shutdown failed: {error}");
        }
    }
}

#[derive(Clone)]
struct Ledger {
    app: AppHandle,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Identity {
    id: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunRequest {
    id: String,
    request_id: String,
}
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CancelRequest {
    run_id: String,
}

fn answer(result: Result<AutomationCatalog>) -> std::result::Result<CallToolResult, String> {
    let catalog = result.map_err(|error| {
        let problem = Problem::from(error);
        serde_json::to_string(&problem)
            .unwrap_or_else(|failure| format!("could not encode automation problem: {failure}"))
    })?;
    serde_json::to_value(catalog)
        .map(CallToolResult::structured)
        .map_err(|error| error.to_string())
}

#[tool_router(server_handler)]
impl Ledger {
    #[tool(
        name = "automations_list",
        description = "Read automation definitions, revisions and native run states. A submission receipt is not completion."
    )]
    async fn list(&self) -> std::result::Result<CallToolResult, String> {
        answer(super::load(&self.app).await)
    }
    #[tool(
        name = "automations_create",
        description = "Create an automation with an explicit absolute workspaceRoot and IANA timeZone. Cron is evaluated by the native scheduler."
    )]
    async fn create(
        &self,
        Parameters(creation): Parameters<AutomationCreation>,
    ) -> std::result::Result<CallToolResult, String> {
        answer(super::execute(&self.app, Command::Create(creation)).await)
    }
    #[tool(
        name = "automations_update",
        description = "Update a definition using its expectedRevision. An active execution retains its claimed input."
    )]
    async fn update(
        &self,
        Parameters(update): Parameters<AutomationUpdate>,
    ) -> std::result::Result<CallToolResult, String> {
        answer(super::execute(&self.app, Command::Update(update)).await)
    }
    #[tool(
        name = "automations_delete",
        description = "Remove an automation definition and its bounded run list. Active or uncertain executions must first settle; conversation records are retained."
    )]
    async fn delete(
        &self,
        Parameters(request): Parameters<Identity>,
    ) -> std::result::Result<CallToolResult, String> {
        answer(super::execute(&self.app, Command::Remove { id: request.id }).await)
    }
    #[tool(
        name = "automations_run",
        description = "Queue one run. Supply a UUID requestId and reuse it if the command response is lost. The native ledger coalesces an already active run."
    )]
    async fn run(
        &self,
        Parameters(request): Parameters<RunRequest>,
    ) -> std::result::Result<CallToolResult, String> {
        answer(super::run(&self.app, request.id, request.request_id).await)
    }
    #[tool(
        name = "automations_cancel",
        description = "Persist cancellation intent for a runId. Only an official terminal observation confirms cancellation."
    )]
    async fn cancel(
        &self,
        Parameters(request): Parameters<CancelRequest>,
    ) -> std::result::Result<CallToolResult, String> {
        answer(
            super::execute(
                &self.app,
                Command::Cancel {
                    run_id: request.run_id,
                },
            )
            .await,
        )
    }
}

pub(crate) fn serve(app: &AppHandle) -> Result<AutomationMcpServer> {
    let socket = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
    socket.set_nonblocking(true)?;
    let address = socket.local_addr()?;
    let endpoint = McpEndpoint {
        url: format!("http://{address}/mcp"),
    };
    let access = Arc::new(Access {
        host: address.to_string(),
        authorization: format!("Bearer {}", uuid::Uuid::new_v4()),
    });
    let alive = Arc::new(AtomicBool::new(true));
    let worker_alive = Arc::clone(&alive);
    let worker_access = Arc::clone(&access);
    let ledger = Ledger { app: app.clone() };
    let (stop, stopping) = oneshot::channel();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let worker = std::thread::Builder::new().name("poietica-automation-mcp".to_owned()).spawn(move || {
        let result = runtime.block_on(async move {
            let socket = tokio::net::TcpListener::from_std(socket)?;
            let service = StreamableHttpService::new(move || Ok(ledger.clone()), Arc::new(NeverSessionManager::default()),
                StreamableHttpServerConfig::default().with_legacy_session_mode(false).with_json_response(true));
            let router = axum::Router::new().route_service("/mcp", service).layer(middleware::from_fn_with_state(worker_access, protect));
            let (finish, finished) = oneshot::channel::<()>();
            let server = axum::serve(socket, router).with_graceful_shutdown(async { let _finished = finished.await; }).into_future();
            tokio::pin!(server);
            tokio::select! {
                result = &mut server => result,
                _stopped = stopping => {
                    let _sent = finish.send(());
                    tokio::time::timeout(Duration::from_secs(5), server).await.map_err(|_| std::io::Error::other("MCP request drain timed out"))?
                }
            }
        });
        worker_alive.store(false, Ordering::Release);
        if let Err(error) = &result { log::error!("automation MCP stopped: {error}"); }
        result
    })?;
    Ok(AutomationMcpServer {
        endpoint,
        access,
        alive,
        stopping: Mutex::new(Some(stop)),
        worker: Mutex::new(Some(worker)),
    })
}

pub(crate) fn configure(app: &AppHandle, contents: Option<&str>) -> Result<String> {
    let server = app
        .try_state::<AutomationMcpServer>()
        .ok_or_else(|| Error::AgentCli("自动化 MCP 尚未启动".to_owned()))?;
    let mut document: serde_json::Value = match contents {
        Some(contents) => serde_json::from_str(contents)?,
        None => serde_json::json!({}),
    };
    let object = document
        .as_object_mut()
        .ok_or_else(|| Error::AgentCli("mcp.json 必须是对象".to_owned()))?;
    let servers = object
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| Error::AgentCli("mcpServers 必须是对象".to_owned()))?;
    servers.insert(SERVER_NAME.to_owned(), server.registration()?);
    Ok(serde_json::to_string_pretty(&document)? + "\n")
}

#[tauri::command]
#[specta::specta]
pub fn mcp_endpoint(app: AppHandle) -> Option<McpEndpoint> {
    app.try_state::<AutomationMcpServer>()
        .filter(|server| server.alive.load(Ordering::Acquire))
        .map(|server| server.endpoint.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn loopback_rebinding_and_browser_origins_are_rejected() {
        let access = Access {
            host: "127.0.0.1:56789".to_owned(),
            authorization: "Bearer token".to_owned(),
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            header::HOST,
            axum::http::HeaderValue::from_static("127.0.0.1:56789"),
        );
        headers.insert(
            header::AUTHORIZATION,
            axum::http::HeaderValue::from_static("Bearer token"),
        );
        assert!(access.accepts(&headers));
        headers.insert(
            header::ORIGIN,
            axum::http::HeaderValue::from_static("https://example.com"),
        );
        assert!(!access.accepts(&headers));
        headers.remove(header::ORIGIN);
        headers.insert(
            header::HOST,
            axum::http::HeaderValue::from_static("example.com:56789"),
        );
        assert!(!access.accepts(&headers));
    }
}
