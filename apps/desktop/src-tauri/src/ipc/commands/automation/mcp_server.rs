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
use std::sync::Arc;

use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::tower::{
    StreamableHttpServerConfig, StreamableHttpService,
};
use rmcp::{tool, tool_router};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, async_runtime, command};
use tokio::net::TcpListener;

use crate::ipc::commands::automation::{
    Automation, AutomationCreation, create, mutate, open, read_catalog,
};

/// 服务器的落脚地址。渲染层照着它把这台服务器登记进 MCP 那一格。
#[derive(Clone, Debug, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpEndpoint {
    pub url: String,
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
pub fn serve(app: &AppHandle) -> io::Result<()> {
    let socket = StdTcpListener::bind(("127.0.0.1", 0))?;

    socket.set_nonblocking(true)?;

    let address = socket.local_addr()?;

    app.manage(McpEndpoint {
        url: format!("http://{address}/mcp"),
    });

    let app = app.clone();

    async_runtime::spawn(async move {
        if let Err(cause) = listen(app, socket).await {
            /*
             * 服务器起不来只影响这一个能力，应用其余部分照常。为它中断启动，等于让
             * 一个附加通道的故障拖垮整个进程。
             */
            log::warn!("the automation MCP server stopped: {cause}");
        }
    });

    Ok(())
}

async fn listen(app: AppHandle, socket: StdTcpListener) -> io::Result<()> {
    let ledger = Ledger { app };
    /*
     * 配置走 Default 而不是结构体表达式：这个类型标了 non_exhaustive，定义 crate 之
     * 外用结构体表达式构造是 E0639，带函数式更新语法也一样不行。要改字段时用它自己
     * 的 with_* builder。默认值本来就只接受回环 Host。
     */
    let service = StreamableHttpService::new(
        move || Ok(ledger.clone()),
        Arc::new(LocalSessionManager::default()),
        StreamableHttpServerConfig::default(),
    );
    let listener = TcpListener::from_std(socket)?;

    axum::serve(listener, axum::Router::new().fallback_service(service)).await
}

/// Reports where the in-process MCP server is listening.
///
/// Returns None while the server failed to bind: the caller then simply has no
/// built-in server to register, which is a state the UI can show.
#[command]
#[specta::specta]
pub async fn mcp_endpoint(app: AppHandle) -> Option<McpEndpoint> {
    app.try_state::<McpEndpoint>()
        .map(|state| state.inner().clone())
}
