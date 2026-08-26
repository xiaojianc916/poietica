//! 一次性的目录文档服务。
//!
//! agent 的 catalog add 只吃一个 http(s) 目录 URL —— 那是它读协议类型、接口地址与
//! 模型清单的唯一入口。默认目录 models.dev 在部分网络下不可达，拉不到就 exit 1。
//! 这里把渲染层带来的那份文档绑在 127.0.0.1 上，经官方 --url 喂给它。
//!
//! 三道守卫：路径里的一次性凭据挡本机盲猜、Host 必须等于本次绑定地址挡 DNS
//! rebinding、答过一次即停。HTTP 不手写 —— 报文解析、超时与优雅停机归 axum，
//! 它已经在 mcp.rs 里服务这同一个进程。

use std::fmt;
use std::io;
use std::net::TcpListener as StdTcpListener;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use tauri::async_runtime;
use tokio::net::TcpListener;
use tokio::sync::watch;
use uuid::Uuid;

/// 总时限。对方在这之内不来取，这次调用本来也已经失败了。
const LIFETIME: Duration = Duration::from_secs(30);

/// 这次调用认得的那一份地址，以及答完之后用来收摊的旗标。
struct Served {
    document: String,
    token: String,
    host: String,
    stop: Arc<watch::Sender<bool>>,
}

/// 绑在 loopback 上的一次性目录服务。答过一次即停；Drop 提前收摊。
pub struct CatalogServer {
    url: String,
    stop: Arc<watch::Sender<bool>>,
}

/// Debug 不打载荷：url 里带着这次调用的凭据。
impl fmt::Debug for CatalogServer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CatalogServer")
            .finish_non_exhaustive()
    }
}

impl CatalogServer {
    /// 在 127.0.0.1 的随机端口上服务这份文档，直到被取走一次、超时，或被 Drop。
    ///
    /// 先绑、后算地址、再 spawn：返回 Ok 就意味着 url() 已经可查。
    ///
    /// # Errors
    ///
    /// 回环端口绑不上时返回 io 错误 —— 那种情况下也不该继续这次调用。
    pub fn start(document: String) -> io::Result<Self> {
        let socket = StdTcpListener::bind(("127.0.0.1", 0))?;

        socket.set_nonblocking(true)?;

        let host = socket.local_addr()?.to_string();
        /* 凭据取自操作系统随机源（uuid 的 v4 走 getrandom），不借 RandomState 的种子。 */
        let token = format!("{}.json", Uuid::new_v4().simple());
        let url = format!("http://{host}/{token}");

        let stop = Arc::new(watch::channel(false).0);
        let stopped = stop.subscribe();

        let state = Arc::new(Served {
            document,
            token,
            host,
            stop: Arc::clone(&stop),
        });

        async_runtime::spawn(async move {
            if let Err(cause) = serve(socket, state, stopped).await {
                log::warn!("目录服务没能起来：{cause}");
            }
        });

        Ok(Self { url, stop })
    }

    /// 喂给 agent CLI 的目录地址。凭据在路径里，地址从绑定结果现算。
    pub fn url(&self) -> String {
        self.url.clone()
    }
}

impl Drop for CatalogServer {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
    }
}

async fn serve(
    socket: StdTcpListener,
    state: Arc<Served>,
    mut stopped: watch::Receiver<bool>,
) -> io::Result<()> {
    let listener = TcpListener::from_std(socket)?;

    let router = Router::new()
        .route("/{token}", get(document))
        .with_state(state);

    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            tokio::select! {
                _ = stopped.changed() => {}
                () = tokio::time::sleep(LIFETIME) => {}
            }
        })
        .await
}

/// 凭据与 Host 两条都要过。
async fn document(
    State(state): State<Arc<Served>>,
    Path(token): Path<String>,
    headers: HeaderMap,
) -> Response {
    /*
     * 答过一次这条地址就没有用处了，不论这一次是 200 还是 404：凭据对不上说明来的
     * 不是我们喂出去的那个 URL。优雅停机会等这一次响应写完再收端口。
     */
    let _ = state.stop.send(true);

    let host_matches = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value == state.host);

    if token != state.token || !host_matches {
        return StatusCode::NOT_FOUND.into_response();
    }

    (
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        state.document.clone(),
    )
        .into_response()
}
