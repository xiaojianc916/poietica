// kap-transport-v1
//!
//! kap 传输驱动器。
//!
//! 进程模型：spawn "kimi web --no-open" → 轮询实例注册表直到出现本进程 pid →
//! 读 server.token → 建 WS 连接 → client_hello/subscribe → 主循环收命令/收事件。
//!
//! 数据流：
//!   命令 → Command 枚举 → REST POST（prompt/approve）或 WS 消息（abort/shutdown）
//!   事件 → WS session_event → frame.rs::kap_event() → RecordedEvent → Tauri

use std::path::{Path, PathBuf};
use std::time::Duration;

use futures::channel::{mpsc, oneshot};
use futures::{FutureExt, SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        client::IntoClientRequest,
        http::header::{AUTHORIZATION, SEC_WEBSOCKET_PROTOCOL},
        Message,
    },
};
use uuid::Uuid;

use crate::commands::{AgentClient, Command, PromptImage};
use crate::config::{ConfigControl, controls};
use crate::desk::PermissionDesk;
use crate::error::{KapError, Refusal, Result};
use crate::frame::kap_event;
use crate::permission::{Decision, decide};
use crate::program::resolve_program;
use crate::recorder::Recorder;
use crate::run_slot::RunSlot;
use crate::session::{
    AgentConnection, AgentSpawn, CanCancelSession, CanDeleteSession,
    CanForkSession, CanLoadSession, Handshake, OpenedSession, SessionEntry,
    SessionEvent, SessionEvents,
};
use crate::sessions::SessionBook;
use crate::stderr::StderrLog;
use crate::trace::{open_trace, trace};

// ── 实例注册表 ─────────────────────────────────────────────────────────────────

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

// ── 会话状态 ────────────────────────────────────────────────────────────────────

/// 主循环里一条已知会话的运行时状态。
struct SessionState {
    /// 当前在飞的 prompt_id（若有）。
    active_prompt_id: Option<String>,
    /// 待回答的审批请求 id 列表（approval_id → request_id 映射）。
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

// ── 主入口 ─────────────────────────────────────────────────────────────────────

/// Spawns `kimi web --no-open`, waits for it to register, connects via WS,
/// and returns an `AgentConnection` ready to accept commands.
pub fn connect(spawn: AgentSpawn, slot: RunSlot, desk: PermissionDesk) -> Result<AgentConnection> {
    let AgentSpawn { program, args, cwd, env } = spawn;

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
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| KapError::Spawn { message: e.to_string() })?;

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
        let (host, port) =
            discover_instance(&instances_dir, child_pid, Duration::from_secs(30))
                .await
                .inspect_err(|e| {
                    let _ = ready_tx.send(Err(KapError::Handshake {
                        message: e.to_string(),
                    }));
                })?;

        // 3. 读令牌
        let token = read_token(&home_dir).await.inspect_err(|e| {
            let _ = ready_tx.send(Err(KapError::Handshake {
                message: e.to_string(),
            }));
        })?;

        let base_url = format!("http://{host}:{port}/api/v1");
        let auth_header_value = format!("Bearer {token}");

        // 4. HTTP 客户端
        let http = reqwest::Client::builder()
            .default_headers({
                let mut h = reqwest::header::HeaderMap::new();
                h.insert(
                    reqwest::header::AUTHORIZATION,
                    auth_header_value.parse().unwrap(),
                );
                h
            })
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| KapError::Transport { message: e.to_string() })?;

        // 5. 建初始会话（REST）
        let session_resp = http
            .post(format!("{base_url}/sessions"))
            .json(&json!({ "metadata": { "cwd": cwd.to_string_lossy().as_ref() } }))
            .send()
            .await
            .map_err(|e| KapError::Transport { message: e.to_string() })?;

        let session_body: Value = session_resp
            .json()
            .await
            .map_err(|e| KapError::Transport { message: e.to_string() })?;

        let session_id = session_body["data"]["id"]
            .as_str()
            .ok_or(KapError::Handshake {
                message: format!(
                    "no session id in POST /sessions response: {session_body}"
                ),
            })?
            .to_owned();

        // 6. WebSocket 握手
        let ws_url = format!("ws://{host}:{port}/api/v1/ws");
        let mut ws_req = ws_url
            .into_client_request()
            .map_err(|e| KapError::Transport { message: e.to_string() })?;

        ws_req.headers_mut().insert(
            AUTHORIZATION,
            auth_header_value.parse().unwrap(),
        );

        let (ws_stream, _) = connect_async(ws_req)
            .await
            .map_err(|e| KapError::Handshake { message: e.to_string() })?;

        let (mut ws_tx, mut ws_rx) = ws_stream.split();

        // 等 server_hello
        loop {
            match ws_rx.next().await {
                Some(Ok(Message::Text(raw))) => {
                    if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                        if v["type"] == "server_hello" {
                            break;
                        }
                    }
                }
                Some(Err(e)) => {
                    let _ = ready_tx.send(Err(KapError::Handshake {
                        message: e.to_string(),
                    }));
                    return Err(KapError::Handshake { message: e.to_string() });
                }
                None => {
                    let msg = "WS closed before server_hello".into();
                    let _ = ready_tx.send(Err(KapError::Handshake { message: msg }));
                    return Err(KapError::Handshake {
                        message: "WS closed before server_hello".into(),
                    });
                }
                _ => {}
            }
        }

        // 发 client_hello（含首条会话订阅）
        let client_id = Uuid::new_v4().to_string();
        let hello_id = Uuid::new_v4().to_string();
        ws_tx
            .send(Message::Text(
                json!({
                    "type": "client_hello",
                    "id": hello_id,
                    "payload": {
                        "client_id": client_id,
                        "subscriptions": [session_id],
                        "cursors": { &session_id: { "seq": 0 } }
                    }
                })
                .to_string(),
            ))
            .await
            .map_err(|e| KapError::Transport { message: e.to_string() })?;

        // 等 ack
        loop {
            match ws_rx.next().await {
                Some(Ok(Message::Text(raw))) => {
                    if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                        if v["type"] == "ack" && v["id"] == hello_id {
                            break;
                        }
                    }
                }
                Some(Err(e)) => {
                    return Err(KapError::Handshake { message: e.to_string() });
                }
                None => {
                    return Err(KapError::Handshake {
                        message: "WS closed before client_hello ack".into(),
                    });
                }
                _ => {}
            }
        }

        // 7. 注册槽
        if book_clone.adopt(&session_id, slot).is_err() {
            let _ = ready_tx.send(Err(KapError::Handshake {
                message: "session book is poisoned".into(),
            }));
            return Ok(());
        }

        let _ = ready_tx.send(Ok(Handshake {
            session_id: session_id.clone(),
            loading: Some(CanLoadSession::granted()),
            deleting: Some(CanDeleteSession::granted()),
            forking: Some(CanForkSession::granted()),
            cancelling: Some(CanCancelSession::granted()),
        }));

        // 8. 主循环
        let mut sessions: std::collections::HashMap<String, SessionState> =
            std::collections::HashMap::new();
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
                            if let Some(state) = sessions.get(&sid) {
                                if let Some(pid) = &state.active_prompt_id {
                                    let msg = json!({
                                        "type": "abort",
                                        "id": Uuid::new_v4().to_string(),
                                        "payload": {
                                            "session_id": sid,
                                            "prompt_id": pid,
                                        }
                                    });
                                    ws_tx.send(Message::Text(msg.to_string())).await.ok();
                                }
                            }
                        }

                        Some(Command::NewSession { cwd: new_cwd, mcp_servers: _, reply }) => {
                            let http2 = http.clone();
                            let base2 = base_url.clone();
                            let book2 = book_clone.clone();
                            tokio::spawn(async move {
                                let result = open_kap_session(&http2, &base2, &new_cwd, &book2).await;
                                let _ = reply.send(result);
                            });
                        }

                        Some(Command::LoadSession { session_id: sid, cwd: _, reply }) => {
                            // kap 会话持久化：直接用已有 id 订阅即可。
                            let result = book_clone.open(&sid).map(|_| OpenedSession {
                                session_id: sid.clone(),
                                selectors: vec![],
                            });
                            sessions.entry(sid).or_insert_with(SessionState::new);
                            let _ = reply.send(result);
                        }

                        Some(Command::ForkSession { session_id: src, cwd: _, reply }) => {
                            let http2 = http.clone();
                            let base2 = base_url.clone();
                            let book2 = book_clone.clone();
                            tokio::spawn(async move {
                                let result = fork_kap_session(&http2, &base2, &src, &book2).await;
                                let _ = reply.send(result);
                            });
                        }

                        Some(Command::DeleteSession { session_id: sid, reply }) => {
                            // kap 用 archive 替代删除；本地索引同步移除。
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
                            let http2 = http.clone();
                            let base2 = base_url.clone();
                            let book2 = book_clone.clone();
                            let desk2 = desk.clone();

                            if let Some(state) = sessions.get_mut(&sid) {
                                // 记录 run_started
                                let shown: Vec<String> = images.iter().map(|i| i.url.clone()).collect();
                                let recorder = Recorder::new(sid.clone(), {
                                    if let Ok(Some(slot)) = book2.slot(&sid) {
                                        slot.seq()
                                    } else { 0 }
                                }, frames);
                                if let Ok(Some(slot)) = book2.slot(&sid) {
                                    slot.install(recorder).ok();
                                    let _ = slot.record(|r| r.record_run_started(&text, shown));
                                }

                                let prompt_id = Uuid::new_v4().to_string();
                                state.active_prompt_id = Some(prompt_id.clone());

                                let sid2 = sid.clone();
                                tokio::spawn(async move {
                                    let result = submit_kap_prompt(
                                        &http2, &base2, &sid2, &text, &images, &prompt_id,
                                    ).await;
                                    let _ = reply.send(result);
                                });
                            } else {
                                let _ = reply.send(Err(KapError::Refused(Refusal::UnknownSession)));
                            }
                        }

                        Some(Command::Selectors { session_id: sid, reply }) => {
                            // kap 的 config 通过 /sessions/{id}/profile 读取
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
                                let result = set_kap_selector(&http2, &base2, &sid, &config_id, &value).await;
                                let _ = reply.send(result);
                            });
                        }
                    }
                }

                msg = ws_rx.next() => {
                    match msg {
                        None => break, // WS 关了

                        Some(Err(e)) => {
                            log::warn!("kap WS error: {e}");
                            break;
                        }

                        Some(Ok(Message::Text(raw))) => {
                            if let Ok(v) = serde_json::from_str::<Value>(&raw) {
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

                        Some(Ok(Message::Ping(data))) => {
                            ws_tx.send(Message::Pong(data)).await.ok();
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

// ── WS 事件路由 ─────────────────────────────────────────────────────────────────

async fn handle_ws_message(
    envelope: &Value,
    sessions: &mut std::collections::HashMap<String, SessionState>,
    book: &SessionBook,
    desk: &PermissionDesk,
    events_tx: &mpsc::UnboundedSender<SessionEvent>,
    http: &reqwest::Client,
    base_url: &str,
) {
    let msg_type = envelope["type"].as_str().unwrap_or("");

    // session_event 是 agent 事件的统一入口
    if msg_type != "session_event" {
        return;
    }

    let session_id = match envelope["session_id"].as_str() {
        Some(s) => s,
        None => return,
    };

    let payload = &envelope["payload"];
    let event_type = payload["type"].as_str().unwrap_or("");

    // 所有 session_event 都成帧进录制器
    if let Ok(Some(slot)) = book.slot(session_id) {
        let frame = kap_event(payload.clone());
        let _ = slot.record(|recorder| recorder.record_frame(frame));
    }

    // 轮次结束
    if event_type == "turn.ended" {
        if let Some(state) = sessions.get_mut(session_id) {
            let reason = payload["reason"].as_str().unwrap_or("completed");
            if let Ok(Some(slot)) = book.slot(session_id) {
                let _ = slot.record(|recorder| {
                    match reason {
                        "failed" | "blocked" => recorder.record_run_failed(reason),
                        _ => recorder.record_run_finished(reason),
                    }
                });
            }
            state.active_prompt_id = None;
            desk.abandon(vec![]); // 本轮未回答的问题作废
        }
        return;
    }

    // 审批请求（agent.status.updated 里 phase 变为 awaiting_approval）
    if event_type == "agent.status.updated" {
        if let Some(phase) = payload["phase"].as_object() {
            if phase.get("kind").and_then(|v| v.as_str()) == Some("awaiting_approval") {
                // 拉取待审批列表
                let http2 = http.clone();
                let base2 = base_url.to_owned();
                let sid = session_id.to_owned();
                let book2 = book.clone();
                let desk2 = desk.clone();
                tokio::spawn(async move {
                    fetch_and_record_approvals(&http2, &base2, &sid, &book2, &desk2).await;
                });
            }
        }
        return;
    }
}

/// GET /sessions/{id}/approvals → 对每个 pending approval 发起 desk 等待。
async fn fetch_and_record_approvals(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
    book: &SessionBook,
    desk: &PermissionDesk,
) {
    let url = format!("{base_url}/sessions/{session_id}/approvals");
    let resp = match http.get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            log::warn!("GET approvals failed: {e}");
            return;
        }
    };

    let body: Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => {
            log::warn!("GET approvals json parse failed: {e}");
            return;
        }
    };

    let items = match body["data"]["items"].as_array() {
        Some(a) => a.clone(),
        None => return,
    };

    for item in items {
        let approval_id = match item["approval_id"].as_str() {
            Some(s) => s.to_owned(),
            None => continue,
        };

        if let Ok(Some(slot)) = book.slot(session_id) {
            // 记录 permission_requested 帧
            let _ = slot.record(|recorder| {
                let req_id = recorder.record_permission_requested_kap(
                    &approval_id,
                    item["tool_call_id"].as_str().unwrap_or(""),
                    item["tool_name"].as_str().unwrap_or(""),
                    &item,
                );
                req_id
            });
        }

        // 等用户决定
        let Ok(answer_rx) = desk.wait_kap(&approval_id) else { continue };

        let http2 = http.clone();
        let base2 = base_url.to_owned();
        let sid2 = session_id.to_owned();
        let book2 = book.clone();

        tokio::spawn(async move {
            let decision = answer_rx.await.unwrap_or(Decision::Cancel);

            // POST 决定
            let (kap_decision, scope) = match &decision {
                Decision::Cancel => ("reject", "once"),
                _ => ("approve", "once"),
            };

            let url = format!("{base2}/sessions/{sid2}/approvals/{approval_id}");
            http2
                .post(&url)
                .json(&json!({ "decision": kap_decision, "scope": scope }))
                .send()
                .await
                .ok();

            // 记录 permission_resolved 帧
            if let Ok(Some(slot)) = book2.slot(&sid2) {
                let _ = slot.record(|recorder| {
                    recorder.record_permission_resolved_kap(&approval_id, &decision);
                });
            }
        });
    }
}

// ── REST 辅助函数 ──────────────────────────────────────────────────────────────

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
        content.push(json!({
            "type": "image_url",
            "image_url": {
                "url": format!("data:{};base64,{}", image.mime_type, image.data)
            }
        }));
    }

    if content.is_empty() {
        return Err(KapError::Transport {
            message: "prompt has no content".into(),
        });
    }

    let resp = http
        .post(format!("{base_url}/sessions/{session_id}/prompts"))
        .json(&json!({ "content": content, "prompt_id": prompt_id }))
        .send()
        .await
        .map_err(|e| KapError::Transport { message: e.to_string() })?;

    let body: Value = resp
        .json()
        .await
        .map_err(|e| KapError::Transport { message: e.to_string() })?;

    Ok(body["data"]["prompt_id"]
        .as_str()
        .unwrap_or(prompt_id)
        .to_owned())
}

async fn open_kap_session(
    http: &reqwest::Client,
    base_url: &str,
    cwd: &Path,
    book: &SessionBook,
) -> Result<OpenedSession> {
    let resp = http
        .post(format!("{base_url}/sessions"))
        .json(&json!({ "metadata": { "cwd": cwd.to_string_lossy().as_ref() } }))
        .send()
        .await
        .map_err(|e| KapError::Transport { message: e.to_string() })?;

    let body: Value = resp
        .json()
        .await
        .map_err(|e| KapError::Transport { message: e.to_string() })?;

    let id = body["data"]["id"]
        .as_str()
        .ok_or(KapError::Transport {
            message: "no session id in POST /sessions".into(),
        })?
        .to_owned();

    book.open(&id)?;

    Ok(OpenedSession { session_id: id, selectors: vec![] })
}

async fn fork_kap_session(
    http: &reqwest::Client,
    base_url: &str,
    source_id: &str,
    book: &SessionBook,
) -> Result<OpenedSession> {
    let resp = http
        .post(format!("{base_url}/sessions/{source_id}:fork"))
        .json(&json!({}))
        .send()
        .await
        .map_err(|e| KapError::Transport { message: e.to_string() })?;

    let body: Value = resp
        .json()
        .await
        .map_err(|e| KapError::Transport { message: e.to_string() })?;

    let id = body["data"]["id"]
        .as_str()
        .ok_or(KapError::Transport {
            message: "no session id in fork response".into(),
        })?
        .to_owned();

    book.open(&id)?;

    Ok(OpenedSession { session_id: id, selectors: vec![] })
}

async fn archive_kap_session(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
    book: &SessionBook,
) -> Result<()> {
    http.post(format!("{base_url}/sessions/{session_id}:archive"))
        .json(&json!({}))
        .send()
        .await
        .map_err(|e| KapError::Transport { message: e.to_string() })?;

    let _ = book.close(session_id);
    Ok(())
}

async fn list_kap_sessions(
    http: &reqwest::Client,
    base_url: &str,
) -> Result<Vec<SessionEntry>> {
    let resp = http
        .get(format!("{base_url}/sessions"))
        .send()
        .await
        .map_err(|e| KapError::Transport { message: e.to_string() })?;

    let body: Value = resp
        .json()
        .await
        .map_err(|e| KapError::Transport { message: e.to_string() })?;

    let items = body["data"]["items"].as_array().cloned().unwrap_or_default();
    Ok(items
        .iter()
        .filter_map(|item| {
            let id = item["id"].as_str()?.to_owned();
            let title = item["title"].as_str().map(str::to_owned);
            let updated_at = item["updated_at"].as_str().map(str::to_owned);
            Some(SessionEntry { session_id: id, title, updated_at })
        })
        .collect())
}

async fn get_kap_selectors(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
) -> Result<Vec<ConfigControl>> {
    let resp = http
        .get(format!("{base_url}/sessions/{session_id}"))
        .send()
        .await
        .map_err(|e| KapError::Transport { message: e.to_string() })?;

    let body: Value = resp
        .json()
        .await
        .map_err(|e| KapError::Transport { message: e.to_string() })?;

    // kap 的 agent_config.model 是最接近 ACP config_option 的东西
    let model = body["data"]["agent_config"]["model"]
        .as_str()
        .unwrap_or("")
        .to_owned();

    if model.is_empty() {
        return Ok(vec![]);
    }

    Ok(controls(&[serde_json::from_value(json!({
        "id": "model",
        "type": "enum",
        "label": "Model",
        "default": model,
        "options": [{ "id": model, "label": model }]
    }))
    .unwrap_or_default()]))
}

async fn set_kap_selector(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
    config_id: &str,
    value: &str,
) -> Result<Vec<ConfigControl>> {
    if config_id == "model" {
        http.post(format!("{base_url}/sessions/{session_id}/profile"))
            .json(&json!({ "agent_config": { "model": value } }))
            .send()
            .await
            .map_err(|e| KapError::Transport { message: e.to_string() })?;
    }
    get_kap_selectors(http, base_url, session_id).await
}
