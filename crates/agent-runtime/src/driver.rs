// kap-transport-v1
//!
//! kap 传输驱动器。
//!
//! 进程模型：spawn "kimi web --no-open" → 轮询实例注册表直到出现本进程 pid →
//! 读 server.token → REST 开锚会话 → WS client_hello + subscribe → 主循环收命令、
//! 收事件。
//!
//! 数据流：
//!   命令 → Command 枚举 → REST（sessions / prompts / approvals / profile）或
//!   WS 控制帧（subscribe / abort / pong）
//!   事件 → WS session_event → frame.rs 的 kap_event() → RecordedEvent → Tauri
//!
//! 协议事实来源是 MoonshotAI/kimi-code 的 packages/kap-server（routes/ 与
//! protocol/ 两个目录），快照钉在 contracts/kap。信封约定
//! { code, msg, data, request_id }：业务成败看 code，不看 HTTP 状态。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures::channel::{mpsc, oneshot};
use futures::stream::{SplitSink, SplitStream};
use futures::{FutureExt, SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest, http::header::AUTHORIZATION},
};
use uuid::Uuid;

use crate::commands::{AgentClient, Command, PromptImage};
use crate::config::{ConfigControl, controls, selector_patch};
use crate::desk::PermissionDesk;
use crate::error::{KapError, Refusal, Result};
use crate::frame::kap_event;
use crate::permission::kap_response;
use crate::program::resolve_program;
use crate::recorder::Recorder;
use crate::run_slot::RunSlot;
use crate::session::{
    AgentConnection, AgentSpawn, CanCancelSession, CanDeleteSession, CanForkSession,
    CanLoadSession, Handshake, OpenedSession, SessionEntry, SessionEvent, SessionEvents,
};
use crate::sessions::SessionBook;
use crate::stderr::StderrLog;
use crate::trace::{open_trace, trace};

/// 本进程与 kap server 之间的 WebSocket。
type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// 发控制帧的那一头。主循环与「刚开出来的会话要订阅」的任务共用同一个写端，
/// 而 SplitSink 不是 Clone，所以它在锁后面。
type WsSink = Arc<tokio::sync::Mutex<SplitSink<WsStream, Message>>>;

// ── 实例注册表 ─────────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct InstanceDisk {
    pid: u32,
    host: String,
    port: u16,
}

/// 轮询 instances_dir 直到找到 pid 匹配的条目，返回 (host, port)。
/// 超时则报错。
async fn discover_instance(
    instances_dir: &Path,
    child_pid: u32,
    timeout: Duration,
) -> Result<(String, u16)> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if std::time::Instant::now() > deadline {
            return Err(KapError::Timeout {
                message: format!(
                    "kap server (pid {child_pid}) did not register in {}s",
                    timeout.as_secs()
                ),
            });
        }

        if let Ok(mut dir) = tokio::fs::read_dir(instances_dir).await {
            while let Ok(Some(entry)) = dir.next_entry().await {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                if let Ok(content) = tokio::fs::read_to_string(&path).await {
                    if let Ok(info) = serde_json::from_str::<InstanceDisk>(&content) {
                        if info.pid == child_pid {
                            return Ok((info.host, info.port));
                        }
                    }
                }
            }
        }

        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

/// 注册表里的通配绑定（0.0.0.0 / ::）不是每个平台都能拨的地址，同一个监听器
/// 走回环一定到得了。同一规则的另一份在 tools/kap/spec-sync.mjs 的
/// dialableHost。
fn dialable_host(host: &str) -> String {
    if host.is_empty() || host == "0.0.0.0" || host == "::" {
        return "127.0.0.1".to_owned();
    }

    if host.contains(':') {
        return format!("[{host}]");
    }

    host.to_owned()
}

/// <home>/server.token 的内容（去首尾空白）。
async fn read_token(home_dir: &Path) -> Result<String> {
    let path = home_dir.join("server.token");
    tokio::fs::read_to_string(&path)
        .await
        .map(|s| s.trim().to_owned())
        .map_err(|e| KapError::Spawn {
            message: format!("cannot read server.token at {}: {e}", path.display()),
        })
}

// ── REST ───────────────────────────────────────────────────────────────────

/// 取信封里的 data。业务成败在 code 里（0 为成功），HTTP 状态只管传输层
/// （kap-server/AGENTS.md 的信封约定）。
fn envelope_data(body: &Value) -> Result<Value> {
    if body["code"].as_i64() == Some(0) {
        return Ok(body["data"].clone());
    }

    Err(KapError::Transport {
        message: format!(
            "kap answered code {}: {}",
            body["code"],
            body["msg"].as_str().unwrap_or("")
        ),
    })
}

async fn get(http: &reqwest::Client, url: &str) -> Result<Value> {
    let body: Value = http
        .get(url)
        .send()
        .await
        .map_err(|e| KapError::Transport {
            message: e.to_string(),
        })?
        .json()
        .await
        .map_err(|e| KapError::Transport {
            message: e.to_string(),
        })?;

    envelope_data(&body)
}

async fn post(http: &reqwest::Client, url: &str, body: &Value) -> Result<Value> {
    let body: Value = http
        .post(url)
        .json(body)
        .send()
        .await
        .map_err(|e| KapError::Transport {
            message: e.to_string(),
        })?
        .json()
        .await
        .map_err(|e| KapError::Transport {
            message: e.to_string(),
        })?;

    envelope_data(&body)
}

// ── WS 控制帧 ──────────────────────────────────────────────────────────────

/// 发一帧控制帧，返回它的 id。kap 的控制面（subscribe / abort / pong…）都长
/// 一个样：{ type, id, payload }（ws-control.ts）。
async fn send_frame(ws: &WsSink, kind: &str, payload: Value) -> Result<String> {
    let id = Uuid::new_v4().to_string();
    let frame = json!({ "type": kind, "id": id, "payload": payload });

    ws.lock()
        .await
        .send(Message::Text(frame.to_string()))
        .await
        .map_err(|e| KapError::Transport {
            message: e.to_string(),
        })?;

    Ok(id)
}

/// 等某帧的 ack。ack 信封带 code，非零就是服务器拒了这条控制帧。
async fn wait_ack(ws_rx: &mut SplitStream<WsStream>, id: &str) -> Result<()> {
    loop {
        match ws_rx.next().await {
            Some(Ok(Message::Text(raw))) => {
                if let Ok(v) = serde_json::from_str::<Value>(&raw)
                    && v["type"] == "ack"
                    && v["id"] == id
                {
                    return match v["code"].as_i64() {
                        Some(0) | None => Ok(()),
                        Some(code) => Err(KapError::Handshake {
                            message: format!("control frame {id} rejected with code {code}: {raw}"),
                        }),
                    };
                }
            }
            Some(Err(error)) => {
                return Err(KapError::Handshake {
                    message: error.to_string(),
                });
            }
            None => {
                return Err(KapError::Handshake {
                    message: "WS closed before the ack arrived".to_owned(),
                });
            }
            _ => {}
        }
    }
}

/// 把一条会话挂到这条连接的事件流上。不在握手内联订阅：hello 内联订阅是
/// 官方标了 deprecated 的旧式写法（ws-control.ts clientHelloPayloadSchema）。
async fn subscribe(ws: &WsSink, session_id: &str) -> Result<()> {
    send_frame(ws, "subscribe", json!({ "session_ids": [session_id] })).await?;

    Ok(())
}

// ── 会话状态 ───────────────────────────────────────────────────────────────

/// 主循环里一条已知会话的运行时状态。
struct SessionState {
    /// 当前在飞的 prompt_id（若有）。
    active_prompt_id: Option<String>,
    /// 这一轮已请上桌的审批：既是去重的判据，也是轮终要放掉的清单。
    pending_approvals: Vec<String>,
}

impl SessionState {
    fn new() -> Self {
        Self {
            active_prompt_id: None,
            pending_approvals: Vec::new(),
        }
    }
}

// ── 主入口 ─────────────────────────────────────────────────────────────────

/// Spawns kimi web --no-open, waits for it to register, connects via WS,
/// and returns an AgentConnection ready to accept commands.
pub fn connect(spawn: AgentSpawn, slot: RunSlot, desk: PermissionDesk) -> Result<AgentConnection> {
    let AgentSpawn {
        program,
        args,
        cwd,
        env,
    } = spawn;

    // 受控 home 由组合层给（agent-catalog 的 homeVar）；没有它才回落到 agent
    // 自己的 home —— 实例注册表与令牌都在那下面。
    let home_dir: PathBuf = env
        .iter()
        .find(|(k, _)| k == "KIMI_CODE_HOME")
        .map(|(_, v)| PathBuf::from(v))
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".kimi-code")
        });

    let resolved = resolve_program(&program)?;

    let (commands_tx, commands_rx) = mpsc::unbounded::<Command>();
    let (events_tx, events_rx) = mpsc::unbounded::<SessionEvent>();
    let (ready_tx, ready_rx) = oneshot::channel::<Result<Handshake>>();

    let book = SessionBook::new();
    let book_clone = book.clone();

    let diagnostics = StderrLog::new();
    let traced = open_trace();

    let driver = async move {
        // 1. 启动 kimi web --no-open
        let mut child = tokio::process::Command::new(&resolved)
            .args(&args)
            .current_dir(&cwd)
            .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            // 不读就放空：pino 的日志走 stdout，管道不接走，写满缓冲
            // 会把 server 自己噎住。
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| KapError::Spawn {
                message: e.to_string(),
            })?;

        let child_pid = child.id().ok_or(KapError::Spawn {
            message: "child process has no pid".into(),
        })?;

        // stderr 日志透传
        let diag_stderr = diagnostics.clone();
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Some(sink) = traced.as_deref() {
                        trace(sink, "err ", &line);
                    }
                    diag_stderr.push(&line);
                }
            });
        }

        // 2. 等待实例注册
        let instances_dir = home_dir.join("server").join("instances");
        let (host, port) = match discover_instance(&instances_dir, child_pid, Duration::from_secs(30)).await
        {
            Ok(found) => found,
            Err(error) => {
                let _ = ready_tx.send(Err(KapError::Handshake {
                    message: error.to_string(),
                }));
                return Err(error);
            }
        };

        // 3. 读令牌
        let token = match read_token(&home_dir).await {
            Ok(token) => token,
            Err(error) => {
                let _ = ready_tx.send(Err(KapError::Handshake {
                    message: error.to_string(),
                }));
                return Err(error);
            }
        };

        let dial = dialable_host(&host);
        let base_url = format!("http://{dial}:{port}/api/v1");

        // 4. HTTP 客户端：令牌走 Authorization 头（kap 的全局 bearer 鉴权，
        //    kap-server/src/middleware/auth.ts）。
        let auth_header = match reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
        {
            Ok(value) => value,
            Err(error) => {
                let handshake = KapError::Handshake {
                    message: format!("the server token is not a valid header value: {error}"),
                };
                let _ = ready_tx.send(Err(KapError::Handshake {
                    message: handshake.to_string(),
                }));
                return Err(handshake);
            }
        };

        let http = reqwest::Client::builder()
            .default_headers({
                let mut headers = reqwest::header::HeaderMap::new();
                headers.insert(reqwest::header::AUTHORIZATION, auth_header.clone());
                headers
            })
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| KapError::Transport {
                message: e.to_string(),
            })?;

        // 5. 建锚会话（REST）。sessionCreateSchema：metadata.cwd 与
        //    workspace_id 至少给一个。
        let session = match post(
            &http,
            &format!("{base_url}/sessions"),
            &json!({ "metadata": { "cwd": cwd.to_string_lossy() } }),
        )
        .await
        {
            Ok(data) => data,
            Err(error) => {
                let _ = ready_tx.send(Err(KapError::Handshake {
                    message: error.to_string(),
                }));
                return Err(error);
            }
        };

        let Some(session_id) = session["id"].as_str().map(str::to_owned) else {
            let handshake = KapError::Handshake {
                message: format!("no session id in POST /sessions response: {session}"),
            };
            let _ = ready_tx.send(Err(KapError::Handshake {
                message: handshake.to_string(),
            }));
            return Err(handshake);
        };

        // 6. WebSocket 握手：server_hello 先到；client_hello 只需 client_id，
        //    订阅走独立的 subscribe 帧。
        let ws_url = format!("ws://{dial}:{port}/api/v1/ws");
        let mut ws_req = ws_url
            .into_client_request()
            .map_err(|e| KapError::Transport {
                message: e.to_string(),
            })?;

        ws_req.headers_mut().insert(AUTHORIZATION, auth_header);

        let (ws_stream, _) = connect_async(ws_req)
            .await
            .map_err(|e| KapError::Handshake {
                message: e.to_string(),
            })?;

        let (ws_sink, mut ws_rx) = ws_stream.split();
        let ws: WsSink = Arc::new(tokio::sync::Mutex::new(ws_sink));

        // 等 server_hello
        loop {
            match ws_rx.next().await {
                Some(Ok(Message::Text(raw))) => {
                    if let Ok(v) = serde_json::from_str::<Value>(&raw)
                        && v["type"] == "server_hello"
                    {
                        break;
                    }
                }
                Some(Err(error)) => {
                    let handshake = KapError::Handshake {
                        message: error.to_string(),
                    };
                    let _ = ready_tx.send(Err(KapError::Handshake {
                        message: handshake.to_string(),
                    }));
                    return Err(handshake);
                }
                None => {
                    let handshake = KapError::Handshake {
                        message: "WS closed before server_hello".to_owned(),
                    };
                    let _ = ready_tx.send(Err(KapError::Handshake {
                        message: handshake.to_string(),
                    }));
                    return Err(handshake);
                }
                _ => {}
            }
        }

        let hello = match send_frame(&ws, "client_hello", json!({
            "client_id": Uuid::new_v4().to_string(),
        }))
        .await
        {
            Ok(id) => id,
            Err(error) => {
                let _ = ready_tx.send(Err(KapError::Handshake {
                    message: error.to_string(),
                }));
                return Err(error);
            }
        };

        if let Err(error) = wait_ack(&mut ws_rx, &hello).await {
            let _ = ready_tx.send(Err(KapError::Handshake {
                message: error.to_string(),
            }));
            return Err(error);
        }

        // 7. 注册槽 + 订阅锚会话
        if book_clone.adopt(&session_id, slot).is_err() {
            let _ = ready_tx.send(Err(KapError::Handshake {
                message: "session book is poisoned".into(),
            }));
            return Ok(());
        }

        let anchor_sub = match send_frame(&ws, "subscribe", json!({
            "session_ids": [&session_id],
        }))
        .await
        {
            Ok(id) => id,
            Err(error) => {
                let _ = ready_tx.send(Err(KapError::Handshake {
                    message: error.to_string(),
                }));
                return Err(error);
            }
        };

        if let Err(error) = wait_ack(&mut ws_rx, &anchor_sub).await {
            let _ = ready_tx.send(Err(KapError::Handshake {
                message: error.to_string(),
            }));
            return Err(error);
        }

        let _ = ready_tx.send(Ok(Handshake {
            session_id: session_id.clone(),
            // kap 的会话在 server 侧持久，装载 / 归档 / 分叉 / 中止都有对应路由
            // （load_kap_session、:archive、:fork、abort 控制帧）。
            loading: Some(CanLoadSession::granted()),
            deleting: Some(CanDeleteSession::granted()),
            forking: Some(CanForkSession::granted()),
            cancelling: Some(CanCancelSession::granted()),
        }));

        // 8. 主循环
        let mut sessions: HashMap<String, SessionState> = HashMap::new();
        sessions.insert(session_id.clone(), SessionState::new());

        let mut commands_rx = commands_rx;
        let mut stopping = false;

        loop {
            tokio::select! {
                cmd = commands_rx.next(), if !stopping => {
                    match cmd {
                        None | Some(Command::Shutdown) => {
                            stopping = true;
                            child.kill().await.ok();
                        }

                        Some(Command::Cancel { session_id: sid }) => {
                            if let Some(state) = sessions.get(&sid)
                                && let Some(prompt_id) = &state.active_prompt_id
                            {
                                send_frame(&ws, "abort", json!({
                                    "session_id": sid,
                                    "prompt_id": prompt_id,
                                }))
                                .await
                                .ok();
                            }
                        }

                        Some(Command::NewSession { cwd: new_cwd, mcp_servers: _, reply }) => {
                            let http2 = http.clone();
                            let base2 = base_url.clone();
                            let book2 = book_clone.clone();
                            let ws2 = ws.clone();
                            tokio::spawn(async move {
                                let result =
                                    open_kap_session(&http2, &base2, &new_cwd, &book2, &ws2).await;
                                let _ = reply.send(result);
                            });
                        }

                        Some(Command::LoadSession { session_id: sid, cwd: _, reply }) => {
                            let http2 = http.clone();
                            let base2 = base_url.clone();
                            let book2 = book_clone.clone();
                            let ws2 = ws.clone();
                            tokio::spawn(async move {
                                let result =
                                    load_kap_session(&http2, &base2, &sid, &book2, &ws2).await;
                                let _ = reply.send(result);
                            });
                        }

                        Some(Command::ForkSession { session_id: src, cwd: _, reply }) => {
                            let http2 = http.clone();
                            let base2 = base_url.clone();
                            let book2 = book_clone.clone();
                            let ws2 = ws.clone();
                            tokio::spawn(async move {
                                let result =
                                    fork_kap_session(&http2, &base2, &src, &book2, &ws2).await;
                                let _ = reply.send(result);
                            });
                        }

                        Some(Command::DeleteSession { session_id: sid, reply }) => {
                            // kap 没有硬删除，删除由 :archive 承接；本地索引同步移除。
                            let http2 = http.clone();
                            let base2 = base_url.clone();
                            let book2 = book_clone.clone();
                            tokio::spawn(async move {
                                let result = archive_kap_session(&http2, &base2, &sid, &book2).await;
                                let _ = reply.send(result);
                            });
                        }

                        Some(Command::Sessions { reply }) => {
                            let http2 = http.clone();
                            let base2 = base_url.clone();
                            tokio::spawn(async move {
                                let result = list_kap_sessions(&http2, &base2).await;
                                let _ = reply.send(result);
                            });
                        }

                        Some(Command::Prompt { session_id: sid, text, images, frames, reply }) => {
                            // 本次连接没开过这个号，它就不是我们的话。
                            let held = book_clone.slot(&sid).ok().flatten();

                            if let Some(slot) = held {
                                let shown: Vec<String> =
                                    images.iter().map(|i| i.url.clone()).collect();

                                let recorder = Recorder::new(sid.clone(), slot.seq(), frames);

                                if slot.install(recorder).is_err() {
                                    // 上一轮还没收摊（turn.ended 没到）：一条会话
                                    // 同时只走一轮。
                                    let _ = reply.send(Err(KapError::Refused(Refusal::Busy)));
                                } else {
                                    slot.record(|r| r.record_run_started(&text, shown));

                                    let prompt_id = Uuid::new_v4().to_string();
                                    sessions
                                        .entry(sid.clone())
                                        .or_insert_with(SessionState::new)
                                        .active_prompt_id = Some(prompt_id.clone());

                                    let http2 = http.clone();
                                    let base2 = base_url.clone();
                                    let book2 = book_clone.clone();
                                    let sid2 = sid.clone();
                                    tokio::spawn(async move {
                                        let result = submit_kap_prompt(
                                            &http2, &base2, &sid2, &text, &images, &prompt_id,
                                        )
                                        .await;

                                        if let Err(error) = &result {
                                            // 提问根本没上路：这一轮就此判死，
                                            // 槽收掉，下一句还能来。
                                            if let Ok(Some(slot)) = book2.slot(&sid2)
                                                && let Ok(Some(mut recorder)) = slot.take()
                                            {
                                                recorder.record_run_failed(&error.to_string());
                                            }
                                        }

                                        let _ = reply.send(result);
                                    });
                                }
                            } else {
                                let _ = reply.send(Err(KapError::Refused(Refusal::UnknownSession)));
                            }
                        }

                        Some(Command::Selectors { session_id: sid, reply }) => {
                            let http2 = http.clone();
                            let base2 = base_url.clone();
                            tokio::spawn(async move {
                                let result = get_kap_selectors(&http2, &base2, &sid).await;
                                let _ = reply.send(result);
                            });
                        }

                        Some(Command::Select { session_id: sid, config_id, value, reply }) => {
                            let http2 = http.clone();
                            let base2 = base_url.clone();
                            tokio::spawn(async move {
                                let result =
                                    set_kap_selector(&http2, &base2, &sid, &config_id, &value)
                                        .await;
                                let _ = reply.send(result);
                            });
                        }
                    }
                }

                msg = ws_rx.next() => {
                    match msg {
                        None => break,

                        Some(Err(error)) => {
                            log::warn!("kap WS error: {error}");
                            break;
                        }

                        Some(Ok(Message::Text(raw))) => {
                            if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                                if v["type"] == "ping" {
                                    // kap 的心跳是应用层帧（ws-control.ts 的
                                    // ping/pong），与 tungstenite 的协议层
                                    // Ping 是两回事 —— 两个都要答。
                                    let nonce = v["payload"]["nonce"].clone();
                                    send_frame(&ws, "pong", json!({ "nonce": nonce }))
                                        .await
                                        .ok();
                                } else {
                                    handle_ws_message(
                                        &v,
                                        &mut sessions,
                                        &book_clone,
                                        &desk,
                                        &events_tx,
                                        &http,
                                        &base_url,
                                    )
                                    .await;
                                }
                            }
                        }

                        Some(Ok(Message::Ping(data))) => {
                            ws.lock().await.send(Message::Pong(data)).await.ok();
                        }

                        _ => {}
                    }

                    if stopping && sessions.values().all(|s| s.active_prompt_id.is_none()) {
                        break;
                    }
                }
            }
        }

        desk.clear();
        Ok(())
    }
    .boxed();

    Ok(AgentConnection {
        book,
        client: AgentClient::new(commands_tx),
        handshake: ready_rx,
        events: SessionEvents::new(events_rx),
        driver,
    })
}

// ── WS 事件路由 ────────────────────────────────────────────────────────────

async fn handle_ws_message(
    envelope: &Value,
    sessions: &mut HashMap<String, SessionState>,
    book: &SessionBook,
    desk: &PermissionDesk,
    events_tx: &mpsc::UnboundedSender<SessionEvent>,
    http: &reqwest::Client,
    base_url: &str,
) {
    // session_event 是 agent 事件的统一入口（ws-control.ts sessionEventOperation）。
    if envelope["type"].as_str().unwrap_or("") != "session_event" {
        return;
    }

    let Some(session_id) = envelope["session_id"].as_str() else {
        return;
    };

    let payload = &envelope["payload"];
    let event_type = payload["type"].as_str().unwrap_or("");

    // 所有 session_event 都成帧进录制器。
    if let Ok(Some(slot)) = book.slot(session_id) {
        let frame = kap_event(payload.clone());
        slot.record(|recorder| recorder.record_frame(frame));
    }

    match event_type {
        // 轮次结束：收掉这一轮的记录器，没答的审批作废，终帧殿后。
        "turn.ended" => {
            let reason = payload["reason"].as_str().unwrap_or("completed");

            let state = sessions
                .entry(session_id.to_owned())
                .or_insert_with(SessionState::new);
            state.active_prompt_id = None;
            let outstanding = std::mem::take(&mut state.pending_approvals);

            if let Ok(Some(slot)) = book.slot(session_id)
                && let Ok(Some(mut recorder)) = slot.take()
            {
                recorder.record_pending_cancelled();

                match reason {
                    "failed" | "blocked" => recorder.record_run_failed(reason),
                    _ => recorder.record_run_finished(reason),
                }
            }

            desk.abandon(&outstanding);
        }

        "agent.status.updated" => {
            // 仪表值是 volatile 信号（不进帧日志）：到达即替换。
            if let (Some(used), Some(size)) = (
                payload["contextTokens"].as_u64(),
                payload["maxContextTokens"].as_u64(),
            ) {
                let _sent = events_tx.unbounded_send(SessionEvent::Usage {
                    session_id: session_id.to_owned(),
                    usage: json!({ "contextTokens": used, "maxContextTokens": size }),
                });
            }

            // 卡在审批上：审批清单不随事件来（phase 里那格 approval 是
            // unknown），权威在 REST。
            if payload["phase"]["kind"].as_str() == Some("awaiting_approval")
                && let Some(state) = sessions.get_mut(session_id)
            {
                fetch_and_record_approvals(http, base_url, session_id, state, book, desk).await;
            }
        }

        _ => {}
    }
}

/// agent 报它卡在审批上时，把这条会话挂着的审批逐个请上桌。
///
/// status=pending 是必填 query（rest-approval.ts 的
/// listPendingApprovalsQuerySchema），不带它服务器回 40001。
async fn fetch_and_record_approvals(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
    state: &mut SessionState,
    book: &SessionBook,
    desk: &PermissionDesk,
) {
    let url = format!("{base_url}/sessions/{session_id}/approvals?status=pending");

    let data = match get(http, &url).await {
        Ok(data) => data,
        Err(error) => {
            log::warn!("could not list the pending approvals: {error}");
            return;
        }
    };

    let items = data["items"].as_array().cloned().unwrap_or_default();

    for item in items {
        let Some(approval_id) = item["approval_id"].as_str().map(str::to_owned) else {
            continue;
        };

        // 同一个审批会随每一份 agent.status.updated 再报一次：桌上已经有了的
        // 不记第二帧、不等第二份答案。
        if state.pending_approvals.contains(&approval_id) {
            continue;
        }

        if let Ok(Some(slot)) = book.slot(session_id) {
            slot.record(|recorder| {
                recorder.record_permission_requested_kap(
                    &approval_id,
                    item["tool_call_id"].as_str().unwrap_or(""),
                    item["tool_name"].as_str().unwrap_or(""),
                    &item,
                );
            });
        }

        let Ok(answer_rx) = desk.wait_kap(&approval_id) else {
            continue;
        };

        state.pending_approvals.push(approval_id.clone());

        let http2 = http.clone();
        let base2 = base_url.to_owned();
        let sid = session_id.to_owned();
        let book2 = book.clone();

        tokio::spawn(async move {
            // 发送端被丢掉只有一种情形：这一轮已经结束了（turn.ended 把它从桌上
            // 放掉了）。那时这不再是我们该回答的问题 —— 什么都不发。
            let Ok(decision) = answer_rx.await else {
                return;
            };

            let (decision_on_wire, scope) = kap_response(&decision);

            let mut answer = json!({ "decision": decision_on_wire });

            if let Some(scope) = scope {
                answer["scope"] = json!(scope);
            }

            let url = format!("{base2}/sessions/{sid}/approvals/{approval_id}");

            if let Err(error) = post(&http2, &url, &answer).await {
                log::warn!("could not deliver the approval answer: {error}");
            }

            if let Ok(Some(slot)) = book2.slot(&sid) {
                slot.record(|recorder| {
                    recorder.record_permission_resolved_kap(&approval_id, &decision);
                });
            }
        });
    }
}

// ── 会话的 REST 辅助 ───────────────────────────────────────────────────────

async fn submit_kap_prompt(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
    text: &str,
    images: &[PromptImage],
    prompt_id: &str,
) -> Result<String> {
    let mut content: Vec<Value> = vec![];

    if !text.is_empty() {
        content.push(json!({ "type": "text", "text": text }));
    }

    for image in images {
        // kap 的图像块（protocol/message.ts 的 imageContentSchema）。
        content.push(json!({
            "type": "image",
            "source": {
                "kind": "base64",
                "media_type": image.mime_type,
                "data": image.data,
            }
        }));
    }

    if content.is_empty() {
        return Err(KapError::Transport {
            message: "prompt has no content".into(),
        });
    }

    let data = post(
        http,
        &format!("{base_url}/sessions/{session_id}/prompts"),
        &json!({ "content": content, "prompt_id": prompt_id }),
    )
    .await?;

    Ok(data["prompt_id"].as_str().unwrap_or(prompt_id).to_owned())
}

async fn open_kap_session(
    http: &reqwest::Client,
    base_url: &str,
    cwd: &Path,
    book: &SessionBook,
    ws: &WsSink,
) -> Result<OpenedSession> {
    let data = post(
        http,
        &format!("{base_url}/sessions"),
        &json!({ "metadata": { "cwd": cwd.to_string_lossy() } }),
    )
    .await?;

    let id = data["id"]
        .as_str()
        .ok_or_else(|| KapError::Transport {
            message: format!("no session id in POST /sessions response: {data}"),
        })?
        .to_owned();

    book.open(&id)?;
    subscribe(ws, &id).await?;

    let selectors = best_effort_selectors(http, base_url, &id).await;

    Ok(OpenedSession {
        session_id: id,
        selectors,
    })
}

/// kap 的会话在 server 侧持久：装载 = 验存在 + 重新订阅。号在 server 侧也没了
/// 时，GET 的信封带非零 code，在这里变成 Err —— 调用侧据此走 Forgotten 路径
/// （桌面 seam 的 addressing.rs）。
async fn load_kap_session(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
    book: &SessionBook,
    ws: &WsSink,
) -> Result<OpenedSession> {
    get(http, &format!("{base_url}/sessions/{session_id}")).await?;

    book.open(session_id)?;
    subscribe(ws, session_id).await?;

    let selectors = best_effort_selectors(http, base_url, session_id).await;

    Ok(OpenedSession {
        session_id: session_id.to_owned(),
        selectors,
    })
}

async fn fork_kap_session(
    http: &reqwest::Client,
    base_url: &str,
    source_id: &str,
    book: &SessionBook,
    ws: &WsSink,
) -> Result<OpenedSession> {
    // 动作后缀路由：POST /sessions/{id}:fork（routes/action-suffix.ts）。
    let data = post(
        http,
        &format!("{base_url}/sessions/{source_id}:fork"),
        &json!({}),
    )
    .await?;

    let id = data["id"]
        .as_str()
        .ok_or_else(|| KapError::Transport {
            message: format!("no session id in fork response: {data}"),
        })?
        .to_owned();

    book.open(&id)?;
    subscribe(ws, &id).await?;

    let selectors = best_effort_selectors(http, base_url, &id).await;

    Ok(OpenedSession {
        session_id: id,
        selectors,
    })
}

async fn archive_kap_session(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
    book: &SessionBook,
) -> Result<()> {
    post(
        http,
        &format!("{base_url}/sessions/{session_id}:archive"),
        &json!({}),
    )
    .await?;

    let _ = book.close(session_id);

    Ok(())
}

async fn list_kap_sessions(http: &reqwest::Client, base_url: &str) -> Result<Vec<SessionEntry>> {
    let data = get(http, &format!("{base_url}/sessions")).await?;

    let items = data["items"].as_array().cloned().unwrap_or_default();

    Ok(items
        .iter()
        .filter_map(|item| {
            let id = item["id"].as_str()?.to_owned();
            let title = item["title"].as_str().map(str::to_owned);
            let updated_at = item["updated_at"].as_str().map(str::to_owned);
            Some(SessionEntry {
                session_id: id,
                title,
                updated_at,
            })
        })
        .collect())
}

/// 选择器表：生效值由 status 路由报，候选由 /models 目录报（config.rs 的
/// controls 把两张表拼成一张）。新会话刚出生时表读不出来不是故障 —— 它下一
/// 次被问（capabilities / open_thread）时会再读一次。
async fn best_effort_selectors(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
) -> Vec<ConfigControl> {
    match get_kap_selectors(http, base_url, session_id).await {
        Ok(offered) => offered,
        Err(error) => {
            log::warn!("could not read the session's selectors: {error}");
            Vec::new()
        }
    }
}

async fn get_kap_selectors(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
) -> Result<Vec<ConfigControl>> {
    let status = get(http, &format!("{base_url}/sessions/{session_id}/status")).await?;
    let catalog = get(http, &format!("{base_url}/models")).await?;

    Ok(controls(&status, &catalog))
}

async fn set_kap_selector(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
    config_id: &str,
    value: &str,
) -> Result<Vec<ConfigControl>> {
    let patch = selector_patch(config_id, value).ok_or_else(|| KapError::Transport {
        message: format!("the session offers no selector {config_id} with value {value}"),
    })?;

    post(
        http,
        &format!("{base_url}/sessions/{session_id}/profile"),
        &json!({ "agent_config": patch }),
    )
    .await?;

    get_kap_selectors(http, base_url, session_id).await
}
