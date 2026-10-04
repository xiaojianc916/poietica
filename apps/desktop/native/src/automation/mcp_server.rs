#![allow(
    unused_qualifications,
    reason = "std::result::Result 的全路径是刻意的：rmcp 的 tool/tool_router 宏展开按作用域解析 `Result`，经 crate::error::Result 换名会编译失败"
)]
#![allow(
    clippy::unused_async_trait_impl,
    reason = "rmcp 的 tool_router 把同一个 tool 包成 async trait 方法"
)]
use crate::error::Error;
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
use std::future::IntoFuture;
use std::net::TcpListener;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::thread::JoinHandle;
use std::time::Duration;
use tokio::sync::oneshot;

const SERVER_NAME: &str = "poietica-automations";
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
    endpoint: String,
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
    /// 停掉 MCP 服务：唤醒 worker 并等它退出。
    pub(crate) fn shut_down(&self) -> std::io::Result<()> {
        let mut worker = self
            .worker
            .lock()
            .map_err(|_| std::io::Error::other("MCP worker ownership poisoned"))?;
        self.alive.store(false, Ordering::Release);
        if let Some(signal) = self
            .stopping
            .lock()
            .map_err(|_| std::io::Error::other("MCP stop ownership poisoned"))?
            .take()
        {
            let _sent = signal.send(());
        }
        if let Some(worker) = worker.take() {
            worker
                .join()
                .map_err(|_| std::io::Error::other("MCP worker panicked"))??;
        }
        Ok(())
    }
    fn registration(&self) -> crate::error::Result<serde_json::Value> {
        if !self.alive.load(Ordering::Acquire) {
            return Err(Error::AgentCli("自动化 MCP 服务不可用".to_owned()));
        }
        Ok(
            serde_json::json!({"url":self.endpoint, "headers":{"Authorization":self.access.authorization}}),
        )
    }
}
impl Drop for AutomationMcpServer {
    fn drop(&mut self) {
        if let Err(error) = self.shut_down() {
            tracing::error!("automation MCP shutdown failed: {error}");
        }
    }
}

#[derive(Clone, Copy)]
struct Ledger;
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
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublishRequest {
    /// 图片在本机的绝对路径：截图、图表、导出的图片都行。
    path: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Published {
    /// 写进回复正文的图片地址。
    url: String,
}

/// 读一张要发布的图片。
///
/// 大小先按元数据挡一次：读进内存再判，等于让一条超大文件把宿主拖垮。
async fn read_publishable(path: &str) -> std::result::Result<Vec<u8>, String> {
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|error| format!("图片读不到：{error}"))?;
    if !metadata.is_file() {
        return Err("这个路径不是文件".to_owned());
    }
    if metadata.len() > poietica_asset::MAX_ASSET_BYTES as u64 {
        return Err("图片超过 32 MiB 上限".to_owned());
    }
    tokio::fs::read(path)
        .await
        .map_err(|error| format!("图片读不到：{error}"))
}

fn answer(
    result: crate::error::Result<AutomationCatalog>,
) -> std::result::Result<CallToolResult, String> {
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
        description = "Read automation definitions with their own revisions plus the catalog-level revision, and native run states. A submission receipt is not completion."
    )]
    async fn list(&self) -> std::result::Result<CallToolResult, String> {
        answer(super::host::load().await)
    }
    #[tool(
        name = "automations_create",
        description = "Create an automation with an explicit absolute workspaceRoot and IANA timeZone. Cron is evaluated by the native scheduler."
    )]
    async fn create(
        &self,
        Parameters(creation): Parameters<AutomationCreation>,
    ) -> std::result::Result<CallToolResult, String> {
        answer(super::host::execute(Command::Create(creation)).await)
    }
    #[tool(
        name = "automations_update",
        description = "Update a definition using its expectedRevision: the revision of that single automation in the automations_list result, not the catalog-level top-level revision. An active execution retains its claimed input."
    )]
    async fn update(
        &self,
        Parameters(update): Parameters<AutomationUpdate>,
    ) -> std::result::Result<CallToolResult, String> {
        answer(super::host::execute(Command::Update(update)).await)
    }
    #[tool(
        name = "automations_delete",
        description = "Remove an automation definition and its bounded run list. A run must first be stopped with automations_cancel; removing then drops a not-yet-terminal run and its definition without keeping history, because the ledger cannot hold a run whose definition is gone. Refused while a run's outcome is uncertain. Conversation records are retained."
    )]
    async fn delete(
        &self,
        Parameters(request): Parameters<Identity>,
    ) -> std::result::Result<CallToolResult, String> {
        answer(super::host::execute(Command::Remove { id: request.id }).await)
    }
    #[tool(
        name = "automations_run",
        description = "Queue one run. Supply a UUID requestId and reuse it if the command response is lost. The native ledger coalesces an already active run."
    )]
    async fn run(
        &self,
        Parameters(request): Parameters<RunRequest>,
    ) -> std::result::Result<CallToolResult, String> {
        answer(super::host::run(request.id, request.request_id).await)
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
            super::host::execute(Command::Cancel {
                run_id: request.run_id,
            })
            .await,
        )
    }
    /// 发布一张图片，交回写进回复正文的地址。
    ///
    /// 字节落进发布根、按摘要去重，所以同一张图反复发布只占一份，地址也不变；
    /// 地址由宿主自己的 poietica-asset:// 应答，重启后仍然取得到字节。
    #[tool(
        name = "publish_image",
        description = "Publish a local image file so it can be shown in the reply body as markdown: ![alt](url). Returns a poietica-asset:// url that stays valid across restarts. Use this instead of hosting the file yourself."
    )]
    async fn publish(
        &self,
        Parameters(request): Parameters<PublishRequest>,
    ) -> std::result::Result<CallToolResult, String> {
        let bytes = read_publishable(&request.path).await?;
        let root =
            crate::paths::published_root().map_err(|error| format!("图片发布失败：{error}"))?;

        /* 落盘是阻塞的：在阻塞执行器上做，别占着这条 MCP 的运行线程。 */
        let url = tokio::task::spawn_blocking(move || poietica_asset::publish_image(&root, &bytes))
            .await
            .map_err(|error| format!("图片发布失败：{error}"))?
            .map_err(|error| format!("图片发布失败：{error}"))?;

        serde_json::to_value(Published { url })
            .map(CallToolResult::structured)
            .map_err(|error| error.to_string())
    }
}

pub(crate) fn serve() -> crate::error::Result<AutomationMcpServer> {
    let socket = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
    socket.set_nonblocking(true)?;
    let address = socket.local_addr()?;
    let endpoint = format!("http://{address}/mcp");
    let access = Arc::new(Access {
        host: address.to_string(),
        authorization: format!("Bearer {}", uuid::Uuid::new_v4()),
    });
    let alive = Arc::new(AtomicBool::new(true));
    let worker_alive = Arc::clone(&alive);
    let worker_access = Arc::clone(&access);
    let ledger = Ledger;
    let (stop, stopping) = oneshot::channel();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let worker = std::thread::Builder::new().name("poietica-automation-mcp".to_owned()).spawn(move || {
        let result = runtime.block_on(async move {
            let socket = tokio::net::TcpListener::from_std(socket)?;
            let service = StreamableHttpService::new(move || Ok(ledger), Arc::new(NeverSessionManager::default()),
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
        if let Err(error) = &result { tracing::error!("automation MCP stopped: {error}"); }
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

pub(crate) fn configure(contents: Option<&str>) -> crate::error::Result<String> {
    let server = crate::automation::mcp()?;
    merge_registration(contents, server.registration()?)
}

fn merge_registration(
    contents: Option<&str>,
    registration: serde_json::Value,
) -> crate::error::Result<String> {
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
    servers.insert(SERVER_NAME.to_owned(), registration);
    let mut rendered = serde_json::to_string_pretty(&document)?;
    rendered.push('\n');
    Ok(rendered)
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

    #[test]
    fn builtin_credentials_are_overlaid_without_erasing_user_servers() -> crate::error::Result<()> {
        let document = serde_json::json!({
            "custom": {"preserved":true},
            "mcpServers": {"user-server":{"command":"example"}, "poietica-automations":{"url":"http://127.0.0.1:1/mcp"}}
        });
        let builtin = serde_json::json!({"url":"http://127.0.0.1:2/mcp", "headers":{"Authorization":"Bearer secret"}});
        let merged = merge_registration(Some(&document.to_string()), builtin.clone())?;
        let parsed: serde_json::Value = serde_json::from_str(&merged)?;
        let servers = format!("/mcpServers/{SERVER_NAME}");
        assert_eq!(parsed.pointer(&servers), Some(&builtin));
        assert_eq!(
            parsed.pointer("/mcpServers/user-server"),
            document.pointer("/mcpServers/user-server"),
        );
        assert_eq!(parsed.pointer("/custom"), document.pointer("/custom"));
        assert_eq!(merge_registration(Some(&merged), builtin)?, merged);
        assert!(merge_registration(Some("[]"), serde_json::json!({})).is_err());
        assert!(merge_registration(Some("{\"mcpServers\":null}"), serde_json::json!({})).is_err());
        Ok(())
    }
}
