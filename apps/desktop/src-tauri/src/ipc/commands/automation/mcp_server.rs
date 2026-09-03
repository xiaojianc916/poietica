//! 账本的 MCP 服务器。
//!
//! 为什么在进程内、而不是另起一个 stdio 子进程：账本是 tauri-plugin-store 的一个
//! Store，带进程内缓存，只能经 AppHandle 拿到（见 commands::automation::open）。
//! 子进程要读它就得再写一份存储格式的实现，并且和本进程的缓存赛跑 —— 那是第二份
//! 真相。于是只剩本机回环上的 Streamable HTTP 这一个形状。
//!
//! 端口取 0 由内核分配：Figma 的桌面 MCP 服务器把地址钉死在 127.0.0.1:3845，端口
//! 被别的进程占住时那个开关就整个失效。绑定之后把真实地址交给渲染层，任何一方都不
//! 需要事先约定端口。
//!
//! 不自带鉴权：rmcp 的 Streamable HTTP 服务器默认只接受回环 Host（用于挡住针对本机
//! 服务的 DNS 重绑定），加上内核分配的端口，暴露面与 Figma 的本地服务器同级。

use std::collections::BTreeMap;
use std::io;
use std::net::TcpListener as StdTcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::transport::streamable_http_server::session::never::NeverSessionManager;
use rmcp::transport::streamable_http_server::tower::{
    StreamableHttpServerConfig, StreamableHttpService,
};
use rmcp::{tool, tool_router};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, async_runtime, command};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use crate::ipc::commands::automation::{
    Automation, AutomationCreation, create, mutate, open, read_catalog,
};

/// 服务器的落脚地址。渲染层照着它把这台服务器登记进 MCP 那一格。
#[derive(Clone, Debug, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpEndpoint {
    pub url: String,
}

/// 组合根持有的服务器资源：地址、存活状态和唯一关闭入口归同一个对象。
pub struct AutomationMcpServer {
    endpoint: McpEndpoint,
    alive: Arc<AtomicBool>,
    shutdown: Mutex<Option<oneshot::Sender<()>>>,
}

/// 关闭通道没有 Debug：只印地址与存活，不印它。
impl std::fmt::Debug for AutomationMcpServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AutomationMcpServer")
            .field("endpoint", &self.endpoint)
            .field("alive", &self.alive.load(Ordering::Acquire))
            .finish_non_exhaustive()
    }
}

impl AutomationMcpServer {
    pub fn stop(&self) {
        self.alive.store(false, Ordering::Release);

        match self.shutdown.lock() {
            Ok(mut shutdown) => {
                if let Some(shutdown) = shutdown.take() {
                    let _ = shutdown.send(());
                }
            }
            Err(_poisoned) => {
                log::error!("the automation MCP shutdown channel was poisoned");
            }
        }
    }
}

/// 工具的宿主。它只拿着 AppHandle —— 账本的真相在盘上，这里不留副本。
#[derive(Clone)]
struct Ledger {
    app: AppHandle,
}

#[derive(Debug, Default, Deserialize, JsonSchema)]
struct ListInput {}

/// 递给模型的那一行。
///
/// 不直接把 Automation 递出去：runs 是几十条运行账目，对「有哪些自动化」这个问题
/// 是纯噪音，而工具结果要占模型的上下文窗口。
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct AutomationView {
    id: String,
    title: String,
    prompt: String,
    /// crontab 表达式；缺席表示只在人手动触发时跑。
    schedule: Option<String>,
    enabled: bool,
    next_run_at: Option<String>,
}

impl From<Automation> for AutomationView {
    fn from(automation: Automation) -> Self {
        Self {
            id: automation.id,
            title: automation.title,
            prompt: automation.prompt,
            schedule: automation.schedule,
            enabled: automation.enabled,
            next_run_at: automation.next_run_at,
        }
    }
}

/*
 * 失败写在结果里，不抛协议错误。
 *
 * MCP 规定工具执行失败属于结果的一部分，模型要能看见并据此改变下一步动作；协议层
 * 错误说的是「这次调用根本没成立」，两者不是一回事。读不出账本时把原因如实递给模
 * 型，比让它收到一个空列表当成「你没有自动化」要诚实。
 */
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct ListOutput {
    automations: Vec<AutomationView>,
    failure: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct CreateInput {
    /// 列表里的名字，也是这条自动化开出来的那条对话的标题。
    title: String,
    /// 到期时发给 agent 的那句话。
    prompt: String,
    /// crontab 表达式；缺席表示只在人手动触发时跑。
    schedule: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct UpdateInput {
    /// 要改的那条的 id，取自 automation_list。
    id: String,
    title: String,
    prompt: String,
    /// crontab 表达式；null 表示改成只在手动触发时跑。
    schedule: Option<String>,
    enabled: bool,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct WriteOutput {
    /// 写完之后那一行。日程刚被改动时 nextRunAt 暂缺，由应用排上。
    automation: Option<AutomationView>,
    failure: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct DeleteInput {
    /// 要删掉的那条自动化的 id，取自 automation_list。
    id: String,
}

#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct DeleteOutput {
    /// 这次调用之前它是否还在。删一个已经不在的东西算成功，不算错。
    existed: bool,
    remaining: usize,
    failure: Option<String>,
}

#[allow(
    clippy::unused_async_trait_impl,
    reason = "rmcp 的 tool_router 把同步 tool 包成 async trait 方法"
)]
#[tool_router(server_handler)]
impl Ledger {
    #[tool(
        name = "automation_list",
        description = "List the scheduled automations configured in this Poietica workspace."
    )]
    fn list(&self, Parameters(ListInput {}): Parameters<ListInput>) -> Json<ListOutput> {
        match self.rows() {
            Ok(rows) => Json(ListOutput {
                automations: rows.into_iter().map(AutomationView::from).collect(),
                failure: None,
            }),
            Err(cause) => Json(ListOutput {
                automations: Vec::new(),
                failure: Some(cause),
            }),
        }
    }

    #[tool(
        name = "automation_create",
        description = "Create one scheduled automation. schedule is a crontab expression; omit it for a manual-only automation."
    )]
    fn create(
        &self,
        Parameters(CreateInput {
            title,
            prompt,
            schedule,
        }): Parameters<CreateInput>,
    ) -> Json<WriteOutput> {
        let creation = AutomationCreation {
            title,
            prompt,
            schedule,
            session_config: BTreeMap::new(),
            next_run_at: None,
        };

        match create(&self.app, creation) {
            Ok(catalog) => Json(WriteOutput {
                automation: catalog
                    .automations
                    .first()
                    .cloned()
                    .map(AutomationView::from),
                failure: None,
            }),
            Err(cause) => Json(WriteOutput {
                automation: None,
                failure: Some(cause.to_string()),
            }),
        }
    }

    #[tool(
        name = "automation_update",
        description = "Replace the title, prompt, schedule and enabled state of one automation. Run history is preserved."
    )]
    fn update(
        &self,
        Parameters(UpdateInput {
            id,
            title,
            prompt,
            schedule,
            enabled,
        }): Parameters<UpdateInput>,
    ) -> Json<WriteOutput> {
        let mut written = None;

        let outcome = mutate(&self.app, |automations| {
            let Some(existing) = automations.iter_mut().find(|candidate| candidate.id == id) else {
                return;
            };

            /*
             * 日程动过、刚被启用、或者被停用，下一次到期就作废：重排是日历的事，
             * 而日历在 packages/automations。留 None，持有方看到之后排上。
             */
            if existing.schedule != schedule || enabled != existing.enabled {
                existing.next_run_at = None;
            }

            existing.title = title;
            existing.prompt = prompt;
            existing.schedule = schedule;
            existing.enabled = enabled;

            written = Some(existing.clone());
        });

        match outcome {
            Ok(_) if written.is_none() => Json(WriteOutput {
                automation: None,
                failure: Some("没有这条自动化".to_owned()),
            }),
            Ok(_) => Json(WriteOutput {
                automation: written.map(AutomationView::from),
                failure: None,
            }),
            Err(cause) => Json(WriteOutput {
                automation: None,
                failure: Some(cause.to_string()),
            }),
        }
    }

    #[tool(
        name = "automation_delete",
        description = "Delete one automation by its id. Deleting an automation that is already gone succeeds."
    )]
    fn delete(
        &self,
        Parameters(DeleteInput { id }): Parameters<DeleteInput>,
    ) -> Json<DeleteOutput> {
        let existed = match self.rows() {
            Ok(rows) => rows.iter().any(|candidate| candidate.id == id),
            Err(cause) => {
                return Json(DeleteOutput {
                    existed: false,
                    remaining: 0,
                    failure: Some(cause),
                });
            }
        };

        match mutate(&self.app, move |automations| {
            automations.retain(|candidate| candidate.id != id);
        }) {
            Ok(catalog) => Json(DeleteOutput {
                existed,
                remaining: catalog.automations.len(),
                failure: None,
            }),
            Err(cause) => Json(DeleteOutput {
                existed,
                remaining: 0,
                failure: Some(cause.to_string()),
            }),
        }
    }
}

impl Ledger {
    /// 走的是 tauri 命令那一侧同一个读口，不是第二套读法。
    fn rows(&self) -> Result<Vec<Automation>, String> {
        let store = open(&self.app).map_err(|cause| cause.to_string())?;

        read_catalog(&store)
            .map(|catalog| catalog.automations)
            .map_err(|cause| cause.to_string())
    }
}

/// 起服务器。绑定是同步的，地址在返回之前就已经登记好。
///
/// 先绑后登记再 spawn：调用方在 setup 里拿到 Ok 就意味着端点已经可查，渲染层不会
/// 撞上一个「服务器还没起来」的空窗。
///
/// # Errors
///
/// 回环端口绑不上时返回错误。
pub fn serve(app: &AppHandle) -> io::Result<AutomationMcpServer> {
    let socket = StdTcpListener::bind(("127.0.0.1", 0))?;

    socket.set_nonblocking(true)?;

    let address = socket.local_addr()?;
    let endpoint = McpEndpoint {
        url: format!("{}://{address}/mcp", "http"),
    };
    let alive = Arc::new(AtomicBool::new(true));
    let (shutdown, stopping) = oneshot::channel();
    let server = AutomationMcpServer {
        endpoint,
        alive: Arc::clone(&alive),
        shutdown: Mutex::new(Some(shutdown)),
    };
    let app = app.clone();

    async_runtime::spawn(async move {
        let outcome = listen(app, socket, stopping).await;

        alive.store(false, Ordering::Release);

        if let Err(cause) = outcome {
            log::warn!("the automation MCP server stopped: {cause}");
        }
    });

    Ok(server)
}

async fn listen(
    app: AppHandle,
    socket: StdTcpListener,
    stopping: oneshot::Receiver<()>,
) -> io::Result<()> {
    let ledger = Ledger { app };
    /* CRUD tools have no session state or server-originated messages. Stateless JSON responses
     * avoid owning an idle SSE channel; Streamable HTTP explicitly permits GET to return 405. */
    let service = StreamableHttpService::new(
        move || Ok(ledger.clone()),
        Arc::new(NeverSessionManager::default()),
        StreamableHttpServerConfig::default()
            .with_legacy_session_mode(false)
            .with_json_response(true),
    );
    let listener = TcpListener::from_std(socket)?;

    axum::serve(listener, axum::Router::new().fallback_service(service))
        .with_graceful_shutdown(async move {
            let _ = stopping.await;
        })
        .await
}

/// Reports the endpoint only while the owned server task is alive.
#[command]
#[specta::specta]
pub async fn mcp_endpoint(app: AppHandle) -> Option<McpEndpoint> {
    let server = app.try_state::<AutomationMcpServer>()?;

    server
        .alive
        .load(Ordering::Acquire)
        .then(|| server.endpoint.clone())
}
