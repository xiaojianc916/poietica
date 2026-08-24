//! kap 传输驱动器。
//!
//! 进程模型：spawn "kimi web --no-open" → 等注册表出现本次拉起后的条目、且那个
//! 地址认我们手里的 server.token → REST 开锚会话 → WS client_hello + subscribe
//! → 主循环收命令、收事件。
//!
//! 「等」的判据是认令牌，不是文件出现：start.ts 的第一行就 register，那时 server
//! 还没 listen，条目里的端口只是「要的那个」（DEFAULT_PORT 58627）；端口被占就
//! +1 往上走，绑上之后才 registration.update({ port: boundPort }) 回填真端口。
//! 文件先于监听存在，只信文件就会在这段窗口里拨到别人身上。
//!
//! 事件帧的 type 就是事件自己的 type（turn.ended / assistant.delta / …）：
//! 信封是 { type, seq, session_id, timestamp, payload }，payload 里再带一份
//! 同名 type、agentId 与 sessionId。没有哪一帧的 type 是 "session_event" ——
//! 那是 ws-control.ts 操作目录里那一条的名字，那条自己的 description 写着
//! 「frame type is the payload event type」，wsConnectionV1.ts 的
//! isCoalescableDelta 也是拿 'assistant.delta' 去比 wire 上的 type。
//!
//! 数据流：
//!   命令 → Command 枚举 → REST（sessions / prompts / approvals / profile）或
//!   WS 控制帧（subscribe / abort / pong）
//!   事件 → WS 事件帧（type 即事件类型）→ frame.rs 的 kap_event() → RecordedEvent → Tauri
//!
//! 协议事实来源是 MoonshotAI/kimi-code 的 packages/kap-server（routes/ 与
//! protocol/ 两个目录），快照钉在 contracts/kap。信封约定
//! { code, msg, data, request_id }：业务成败看 code，不看 HTTP 状态。

use std::collections::{HashMap, HashSet};
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

use crate::commands::{AgentClient, Command, PromptImage, PromptSkill};
use crate::config::{ConfigControl, controls, selector_patch};
use crate::desk::{PermissionDesk, QuestionDesk};
use crate::error::{KapError, Refusal, Result};
use crate::frame::kap_event;
use crate::program::resolve_program;
use crate::question::{QuestionGroup, QuestionOutcome};
use crate::recorder::{Recorder, now_millis};
use crate::run_slot::RunSlot;
use crate::session::{
    AgentConnection, AgentSpawn, Cursor, Handshake, McpServer, McpStatus, McpTransport,
    OpenedSession, SessionEntry, SessionEvent, SessionEvents, Skill,
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

/// 取消被 kap 收下之后，等 turn.ended 的宽限期。
///
/// kap 的 :abort 是协作式的，不保证终帧一定回来（commands.rs 的
/// AgentClient::cancel）。屏幕上那条经过由帧日志出，没有终帧就没有终态 ——
/// 所以到期由本机把这一轮收摊，而不是让它永远停在"正在取消"。
const CANCEL_GRACE: Duration = Duration::from_secs(10);

// ── 实例注册表 ─────────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct InstanceDisk {
    host: String,
    port: u16,
    /// 注册时刻（epoch 毫秒，server 写文件的 Date.now()），与本机同一个钟。
    started_at: i64,
}

/// 一次探针：这个地址上的 server 认不认我们手里这份令牌。
///
/// /meta 走全局 bearer 鉴权（start.ts 挂的 createAuthHook），认了才回 code 0。
/// 不能用 healthz —— 它在 defaultIsBypassed 的免鉴权名单里，谁都答得出来。
async fn accepts_token(probe: &reqwest::Client, dial: &str, port: u16, token: &str) -> bool {
    let url = format!("http://{dial}:{port}/api/v1/meta");

    let Ok(response) = probe
        .get(&url)
        .header(AUTHORIZATION, format!("Bearer {token}"))
        .send()
        .await
    else {
        return false;
    };

    let Ok(body) = response.json::<Value>().await else {
        return false;
    };

    envelope_data(&body).is_ok()
}

/// 等到注册表出现本次拉起之后的条目、且那个地址认我们的令牌，返回
/// (host, port, token)。超时则报错。
///
/// 判据是「认令牌」而不是「文件存在」：start.ts 的第一件事就是 register，那时
/// server 还没 listen，条目里的端口只是「要的那个」（DEFAULT_PORT 58627），端口
/// 被占就 +1 往上走，绑上之后才回填。只信文件就会在这段窗口里拨到 58627 上的
/// 别人身上 —— 上一次跑漏下的、或者另一个 home 起的 kimi —— 它拿 40101 顶回来。
///
/// 令牌也在这里读：它是判据的一部分，而且首次启动时是 server 自己把它建出来的，
/// 早读会读空。
///
/// 不比 pid：注册表记的是 server 自己的 pid，而 Windows 上我们拉起的直接子进程
/// 是 .cmd Shim，两边永远对不上。
async fn discover_instance(
    instances_dir: &Path,
    home_dir: &Path,
    not_before: i64,
    timeout: Duration,
) -> Result<(String, u16, String)> {
    let deadline = std::time::Instant::now() + timeout;

    let probe = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| KapError::Transport {
            message: e.to_string(),
        })?;

    let mut refused: Vec<String> = Vec::new();

    loop {
        if std::time::Instant::now() > deadline {
            let tried = if refused.is_empty() {
                "no registered instance answered".to_owned()
            } else {
                format!("these addresses refused it: {}", refused.join(", "))
            };

            return Err(KapError::Timeout {
                message: format!(
                    "no kap server under {} accepted the token at {} within {}s ({tried})",
                    instances_dir.display(),
                    home_dir.join("server.token").display(),
                    timeout.as_secs()
                ),
            });
        }

        // 令牌可能比注册表条目晚落地：首次启动时是 server 自己创建它的。
        let Some(token) = read_token(home_dir).await.ok().filter(|t| !t.is_empty()) else {
            tokio::time::sleep(Duration::from_millis(150)).await;
            continue;
        };

        if let Ok(mut dir) = tokio::fs::read_dir(instances_dir).await {
            while let Ok(Some(entry)) = dir.next_entry().await {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                if let Ok(content) = tokio::fs::read_to_string(&path).await
                    && let Ok(info) = serde_json::from_str::<InstanceDisk>(&content)
                    && info.started_at >= not_before
                {
                    let dial = dialable_host(&info.host);

                    if accepts_token(&probe, &dial, info.port, &token).await {
                        return Ok((info.host, info.port, token));
                    }

                    let address = format!("{dial}:{}", info.port);
                    if !refused.contains(&address) {
                        refused.push(address);
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

/// 关掉整棵进程树，不只是 Shim 那一层：kimi 在 Windows 上是 .cmd，我们拉起的
/// 直接子进程是 cmd.exe，server 是它再拉起来的；单杀 Shim 会把 server 漏在这台
/// 机器上。unix 的 Shim 是 exec 的脚本，pid 就是 server 自己，kill 就够。
async fn kill_tree(child: &mut tokio::process::Child) {
    if cfg!(windows)
        && let Some(pid) = child.id()
    {
        let pid_text = pid.to_string();

        let _tree = tokio::process::Command::new("taskkill")
            .args(["/PID", pid_text.as_str(), "/T", "/F"])
            .output()
            .await;
    }

    child.kill().await.ok();
}

// ── REST ───────────────────────────────────────────────────────────────────

/// 取信封里的 data。业务成败在 code 里（0 为成功），HTTP 状态只管传输层
/// （kap-server/AGENTS.md 的信封约定）。字段一律 .get()：Value 的索引写法在
/// clippy 的 indexing_slicing 下是硬错误，而这个仓把它开着。
fn envelope_data(body: &Value) -> Result<Value> {
    let code = body.get("code").and_then(Value::as_i64).unwrap_or(-1);

    if code == 0 {
        return Ok(body.get("data").cloned().unwrap_or_default());
    }

    Err(KapError::Envelope {
        code,
        message: body
            .get("msg")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
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

/// 等某帧的 ack，返回它的载荷；等待期间到达的其它帧收进 stash。
///
/// 不能丢：ack 是 sendImmediateFrame 发的，它把整条出队队列一次冲干净
/// （wsConnectionV1.ts flush），所以排在 ack 前面的事件帧会先到这里。
async fn wait_ack(
    ws_rx: &mut SplitStream<WsStream>,
    id: &str,
    stash: &mut Vec<Value>,
) -> Result<Value> {
    loop {
        match ws_rx.next().await {
            Some(Ok(Message::Text(raw))) => {
                let Ok(frame) = serde_json::from_str::<Value>(&raw) else {
                    continue;
                };

                if frame.get("type").and_then(Value::as_str) != Some("ack")
                    || frame.get("id").and_then(Value::as_str) != Some(id)
                {
                    stash.push(frame);
                    continue;
                }

                return match frame.get("code").and_then(Value::as_i64) {
                    Some(0) | None => Ok(frame.get("payload").cloned().unwrap_or_default()),
                    Some(code) => Err(KapError::Handshake {
                        message: format!("control frame {id} rejected with code {code}: {raw}"),
                    }),
                };
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

/// 订阅的 ack 永远是 code 0：成败写在载荷的 accepted / not_found 里
/// （wsConnectionV1.ts onSubscribe、ws-control.ts subscribeAckPayloadSchema）。
/// 只看 code 就会把「这条会话没订上」当成订上了，然后一帧不来地等到超时。
async fn wait_subscribe_ack(
    ws_rx: &mut SplitStream<WsStream>,
    id: &str,
    session_id: &str,
    stash: &mut Vec<Value>,
) -> Result<()> {
    let payload = wait_ack(ws_rx, id, stash).await?;

    let accepted = payload
        .get("accepted")
        .and_then(Value::as_array)
        .is_some_and(|ids| ids.iter().any(|entry| entry.as_str() == Some(session_id)));

    if accepted {
        return Ok(());
    }

    Err(KapError::Handshake {
        message: format!("the server did not subscribe {session_id}: {payload}"),
    })
}

/// 把一条会话挂到这条连接的事件流上，返回那一帧的 id。不在握手内联订阅：hello
/// 内联订阅是官方标了 deprecated 的旧式写法（ws-control.ts clientHelloPayloadSchema）。
///
/// 带着读点订阅，server 就从那一帧之后接着发（subscribePayloadSchema 的 cursors、
/// sessionCursorSchema）；接不下去时它回 resync_required，而不是默默从头来。新开
/// 与分叉出来的会话没有读点：它们的流从这一刻才开始。
async fn subscribe(ws: &WsSink, session_id: &str, from: Option<&Cursor>) -> Result<String> {
    let payload = match from {
        Some(Cursor {
            seq,
            epoch: Some(epoch),
        }) => json!({
            "session_ids": [session_id],
            "cursors": { session_id: { "seq": seq, "epoch": epoch } },
        }),
        Some(Cursor { seq, epoch: None }) => json!({
            "session_ids": [session_id],
            "cursors": { session_id: { "seq": seq } },
        }),
        None => json!({ "session_ids": [session_id] }),
    };

    send_frame(ws, "subscribe", payload).await
}

// ── 会话状态 ───────────────────────────────────────────────────────────────

#[derive(Clone, Copy)]
enum ReconcileMessage {
    Poll,
    Reset,
}

#[derive(Debug, Default, Eq, PartialEq)]
struct ReconcileBatch {
    poll: bool,
    reset: bool,
}

impl ReconcileBatch {
    fn push(&mut self, message: ReconcileMessage) {
        match message {
            ReconcileMessage::Poll => self.poll = true,
            ReconcileMessage::Reset => {
                self.reset = true;
                self.poll = false;
            }
        }
    }
}

#[derive(Default)]
struct ReconcileState {
    pending_approvals: HashSet<String>,
    pending_questions: HashSet<String>,
}

impl ReconcileState {
    fn reset(&mut self, desk: &PermissionDesk, questions: &QuestionDesk) {
        let outstanding = self.pending_approvals.drain().collect::<Vec<_>>();
        let unanswered = self.pending_questions.drain().collect::<Vec<_>>();

        desk.abandon(&outstanding);
        questions.abandon(&unanswered);
    }
}

/// A session owns one reconciliation task. The WebSocket loop only enqueues intent.
struct ReconcileOwner {
    messages: mpsc::UnboundedSender<ReconcileMessage>,
    task: tokio::task::JoinHandle<()>,
}

impl ReconcileOwner {
    fn spawn(
        session_id: String,
        http: reqwest::Client,
        base_url: String,
        book: SessionBook,
        desk: PermissionDesk,
        questions: QuestionDesk,
    ) -> Self {
        let (messages, mut incoming) = mpsc::unbounded();
        let task = tokio::spawn(async move {
            let mut state = ReconcileState::default();

            while let Some(first) = incoming.next().await {
                let mut batch = ReconcileBatch::default();
                batch.push(first);

                while let Some(Some(message)) = incoming.next().now_or_never() {
                    batch.push(message);
                }

                if batch.reset {
                    state.reset(&desk, &questions);
                }

                if batch.poll {
                    let ReconcileState {
                        pending_approvals,
                        pending_questions,
                    } = &mut state;

                    futures::join!(
                        fetch_and_record_approvals(
                            &http,
                            &base_url,
                            &session_id,
                            pending_approvals,
                            &book,
                            &desk,
                        ),
                        fetch_and_record_questions(
                            &http,
                            &base_url,
                            &session_id,
                            pending_questions,
                            &book,
                            &questions,
                        ),
                    );
                }
            }

            state.reset(&desk, &questions);
        });

        Self { messages, task }
    }

    fn poll(&self) {
        self.send(ReconcileMessage::Poll);
    }

    fn reset(&self) {
        self.send(ReconcileMessage::Reset);
    }

    fn send(&self, message: ReconcileMessage) {
        if self.messages.unbounded_send(message).is_err() {
            log::warn!("session reconciliation owner stopped unexpectedly");
        }
    }
}

impl Drop for ReconcileOwner {
    fn drop(&mut self) {
        self.task.abort();
    }
}

// ── 主入口 ─────────────────────────────────────────────────────────────────

/// Spawns kimi web --no-open, waits for it to register, connects via WS,
/// and returns an AgentConnection ready to accept commands.
pub fn connect(
    spawn: AgentSpawn,
    slot: RunSlot,
    desk: PermissionDesk,
    questions: QuestionDesk,
) -> Result<AgentConnection> {
    let AgentSpawn {
        program,
        args,
        cwd,
        env,
    } = spawn;

    // 受控 home 由组合层给（agent-catalog 的 homeVar）；没有它才回落到 agent
    // 自己的 home —— 实例注册表与令牌都在那下面。
    let home_dir: PathBuf = env.iter().find(|(k, _)| k == "KIMI_CODE_HOME").map_or_else(
        || {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".kimi-code")
        },
        |(_, v)| PathBuf::from(v),
    );

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
        let spawned_at = now_millis();
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
        let (host, port, token) = match discover_instance(
            &instances_dir,
            &home_dir,
            spawned_at,
            Duration::from_secs(30),
        )
        .await
        {
            Ok(found) => found,
            Err(error) => {
                // 收尸再报：超时的根因多半写在 server 自己的 stderr 上（端口、
                // 配置、崩溃），不带回来就只剩一句"没注册"。
                kill_tree(&mut child).await;

                let message = format!("{error}; server stderr: {}", diagnostics.tail());

                let _ = ready_tx.send(Err(KapError::Handshake {
                    message: message.clone(),
                }));

                return Err(KapError::Handshake { message });
            }
        };

        // 3. 令牌已经在第 2 步读到：只有「认这份令牌的地址」才算发现成功。

        let dial = dialable_host(&host);
        let base_url = format!("http://{dial}:{port}/api/v1");

        // 4. HTTP 客户端：令牌走 Authorization 头（kap 的全局 bearer 鉴权，
        //    kap-server/src/middleware/auth.ts）。
        let auth_header = match reqwest::header::HeaderValue::from_str(&format!("Bearer {token}")) {
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
                headers.insert(AUTHORIZATION, auth_header.clone());
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

        let Some(session_id) = session.get("id").and_then(Value::as_str).map(str::to_owned) else {
            let handshake = KapError::Handshake {
                message: format!("no session id in POST /sessions response: {session}"),
            };
            let _ = ready_tx.send(Err(KapError::Handshake {
                message: handshake.to_string(),
            }));
            return Err(handshake);
        };

        // 5.5 绑模型。放在订阅之前：这是开会话的收尾，不是回合的一部分，
        //     它引发的那几帧不该记进第一轮。
        ensure_model(&http, &base_url, &session_id).await;

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

        // 等 ack 期间到达的事件帧先收着，主循环开张前补投。
        let mut stash: Vec<Value> = Vec::new();

        // 等 server_hello
        loop {
            match ws_rx.next().await {
                Some(Ok(Message::Text(raw))) => {
                    if let Ok(v) = serde_json::from_str::<Value>(&raw)
                        && v.get("type").and_then(Value::as_str) == Some("server_hello")
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

        let hello = match send_frame(
            &ws,
            "client_hello",
            json!({
                "client_id": Uuid::new_v4().to_string(),
            }),
        )
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

        if let Err(error) = wait_ack(&mut ws_rx, &hello, &mut stash).await {
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

        let anchor_sub = match subscribe(&ws, &session_id, None).await {
            Ok(id) => id,
            Err(error) => {
                let _ = ready_tx.send(Err(KapError::Handshake {
                    message: error.to_string(),
                }));
                return Err(error);
            }
        };

        if let Err(error) =
            wait_subscribe_ack(&mut ws_rx, &anchor_sub, &session_id, &mut stash).await
        {
            let _ = ready_tx.send(Err(KapError::Handshake {
                message: error.to_string(),
            }));
            return Err(error);
        }

        let _ = ready_tx.send(Ok(Handshake {
            session_id: session_id.clone(),
        }));

        // 8. 主循环
        let mut owners: HashMap<String, ReconcileOwner> = HashMap::new();

        // 补投握手期间收下的帧。里面可能有一帧 ping 不必答：我们刚发出去的
        // client_hello 与 subscribe 已经刷新了服务端的 lastInboundAt，而它的
        // 判死线是连续两个周期没有任何入站帧（wsConnectionV1.ts onHeartbeat）。
        for envelope in std::mem::take(&mut stash) {
            handle_ws_message(
                &envelope,
                &mut owners,
                &book_clone,
                &desk,
                &questions,
                &events_tx,
                &http,
                &base_url,
            );
        }

        let mut commands_rx = commands_rx;
        loop {
            tokio::select! {
                cmd = commands_rx.next() => {
                    match cmd {
                        None | Some(Command::Shutdown) => {
                            kill_tree(&mut child).await;
                            break;
                        }

                        Some(Command::Cancel { session_id: sid, reply }) => {
                            let http2 = http.clone();
                            let base2 = base_url.clone();
                            let book2 = book_clone.clone();
                            tokio::spawn(async move {
                                let result = abort_session(&http2, &base2, &sid).await;
                                let accepted = result.is_ok();
                                let _ = reply.send(result);

                                /* 请求本身没送出去时这一轮还在 agent 手上，
                                轮终仍由 turn.ended 说话。 */
                                if !accepted {
                                    return;
                                }

                                tokio::time::sleep(CANCEL_GRACE).await;

                                match book2.finish_turn(&sid, "cancelled") {
                                    Ok(true) => log::warn!(
                                        "kap took the abort of {sid} but never ended the turn; closed locally"
                                    ),
                                    Ok(false) => {}
                                    Err(error) => {
                                        log::error!("could not close an aborted turn: {error}");
                                    }
                                }
                            });
                        }

                        Some(Command::NewSession { cwd: new_cwd, reply }) => {
                            let http2 = http.clone();
                            let base2 = base_url.clone();
                            let book2 = book_clone.clone();
                            let ws2 = Arc::clone(&ws);
                            tokio::spawn(async move {
                                let result =
                                    open_session(&http2, &base2, &new_cwd, &book2, &ws2).await;
                                let _ = reply.send(result);
                            });
                        }

                        Some(Command::LoadSession { session_id: sid, from, reply }) => {
                            let http2 = http.clone();
                            let base2 = base_url.clone();
                            let book2 = book_clone.clone();
                            let ws2 = Arc::clone(&ws);
                            tokio::spawn(async move {
                                let result =
                                    load_session(&http2, &base2, &sid, from.as_ref(), &book2, &ws2)
                                        .await;
                                let _ = reply.send(result);
                            });
                        }

                        Some(Command::ForkSession { session_id: src, reply }) => {
                            let http2 = http.clone();
                            let base2 = base_url.clone();
                            let book2 = book_clone.clone();
                            let ws2 = Arc::clone(&ws);
                            tokio::spawn(async move {
                                let result =
                                    fork_session(&http2, &base2, &src, &book2, &ws2).await;
                                let _ = reply.send(result);
                            });
                        }

                        Some(Command::DeleteSession { session_id: sid, reply }) => {
                            // kap 没有硬删除，删除由 :archive 承接；本地索引同步移除。
                            let http2 = http.clone();
                            let base2 = base_url.clone();
                            let book2 = book_clone.clone();
                            tokio::spawn(async move {
                                let result = archive_session(&http2, &base2, &sid, &book2).await;
                                let _ = reply.send(result);
                            });
                        }

                        Some(Command::Sessions { reply }) => {
                            let http2 = http.clone();
                            let base2 = base_url.clone();
                            tokio::spawn(async move {
                                let result = list_sessions(&http2, &base2).await;
                                let _ = reply.send(result);
                            });
                        }

                        Some(Command::Prompt { session_id: sid, text, images, skills, frames, reply }) => {
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
                                    let attached: Vec<String> =
                                        skills.iter().map(|skill| skill.name.clone()).collect();

                                    slot.record(|r| {
                                        r.record_run_started(&text, shown, attached);
                                    });

                                    let http2 = http.clone();
                                    let base2 = base_url.clone();
                                    let book2 = book_clone.clone();
                                    let sid2 = sid.clone();
                                    tokio::spawn(async move {
                                        let result = submit_prompt(
                                            &http2, &base2, &sid2, &text, &images, &skills,
                                        )
                                        .await;

                                        // 提问根本没上路：这一轮就此判死，槽收掉，下一句还能来。
                                        if let Err(error) = &result
                                            && let Err(closing) =
                                                book2.fail_turn(&sid2, &error.to_string())
                                        {
                                            log::error!(
                                                "could not close a turn whose prompt never left: {closing}"
                                            );
                                        }

                                        let _ = reply.send(result);
                                    });
                                }
                            } else {
                                let _ = reply.send(Err(KapError::Refused(Refusal::UnknownSession)));
                            }
                        }

                        Some(Command::Skills { session_id: sid, reply }) => {
                            let http2 = http.clone();
                            let base2 = base_url.clone();
                            tokio::spawn(async move {
                                let result = list_skills(&http2, &base2, &sid).await;
                                let _ = reply.send(result);
                            });
                        }

                        Some(Command::McpServers { reply }) => {
                            let http2 = http.clone();
                            let base2 = base_url.clone();
                            tokio::spawn(async move {
                                let result = list_mcp_servers(&http2, &base2).await;
                                let _ = reply.send(result);
                            });
                        }

                        Some(Command::Selectors { session_id: sid, reply }) => {
                            let http2 = http.clone();
                            let base2 = base_url.clone();
                            tokio::spawn(async move {
                                let result = get_selectors(&http2, &base2, &sid).await;
                                let _ = reply.send(result);
                            });
                        }

                        Some(Command::Select { session_id: sid, config_id, value, input, reply }) => {
                            let http2 = http.clone();
                            let base2 = base_url.clone();
                            tokio::spawn(async move {
                                let result =
                                    set_selector(&http2, &base2, &sid, &config_id, &value, input.as_deref())
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
                                if v.get("type").and_then(Value::as_str) == Some("ping") {
                                    // kap 的心跳是应用层帧（ws-control.ts 的
                                    // ping/pong），与 tungstenite 的协议层
                                    // Ping 是两回事 —— 两个都要答。
                                    let nonce = v
                                        .get("payload")
                                        .and_then(|payload| payload.get("nonce"))
                                        .cloned()
                                        .unwrap_or_default();
                                    send_frame(&ws, "pong", json!({ "nonce": nonce }))
                                        .await
                                        .ok();
                                } else {
                                    handle_ws_message(
                                        &v,
                                        &mut owners,
                                        &book_clone,
                                        &desk,
                                        &questions,
                                        &events_tx,
                                        &http,
                                        &base_url,
                                    );
                                }
                            }
                        }

                        Some(Ok(Message::Ping(data))) => {
                            ws.lock().await.send(Message::Pong(data)).await.ok();
                        }

                        _ => {}
                    }

                }
            }
        }

        drop(owners);
        desk.clear();
        questions.clear();
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

fn handle_ws_message(
    envelope: &Value,
    owners: &mut HashMap<String, ReconcileOwner>,
    book: &SessionBook,
    desk: &PermissionDesk,
    questions: &QuestionDesk,
    events_tx: &mpsc::UnboundedSender<SessionEvent>,
    http: &reqwest::Client,
    base_url: &str,
) {
    // 事件帧的 type 就是事件自己的 type（turn.ended / assistant.delta / …），
    // 不是字符串 "session_event"：wsEventEnvelopeSchema 里 type 是 z.string()，
    // sessionEventOperation 的 'session_event' 只是操作目录里那一条的名字。
    //
    // 判据：同时带 session_id、seq 和一个自带 type 的载荷，且两个 type 相等。
    // 控制帧与系统帧就此排除 —— 系统 error 帧的载荷是 { code, msg, fatal }，
    // 既没有 type 也没有 seq，不会被当成 agent 的 error 事件收进来。
    let kind = envelope.get("type").and_then(Value::as_str).unwrap_or("");

    // 订阅失败不写在 code 上：ack 永远回 0，落选的会话在载荷的 not_found 里。
    // 异步订阅（新开 / 装载 / 分叉）的 ack 只到得了这里。
    if kind == "ack"
        && let Some(missing) = envelope
            .get("payload")
            .and_then(|payload| payload.get("not_found"))
            .and_then(Value::as_array)
        && !missing.is_empty()
    {
        log::warn!("kap refused to subscribe: {missing:?}");
        return;
    }

    // kap 说这条会话的事件流断了（buffer_overflow / session_recreated /
    // epoch_changed，见 ws-control.ts 的 resyncRequiredPayloadSchema）：断点之后的
    // 帧不会再来，这一轮的经过补不齐。判死它 —— 补不回来的东西不该装作还在路上。
    if kind == "resync_required" {
        let cut = envelope
            .get("payload")
            .and_then(|payload| payload.get("session_id"))
            .or_else(|| envelope.get("session_id"))
            .and_then(Value::as_str)
            .unwrap_or_default();

        let reason = envelope
            .get("payload")
            .and_then(|payload| payload.get("reason"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");

        /* 读点从这一段流上接不下去了，所以它作废：留着它，下一次订阅只会再换
        回一句 resync_required。 */
        let _sent = events_tx.unbounded_send(SessionEvent::CursorLost {
            session_id: cut.to_owned(),
        });

        if let Some(owner) = owners.get(cut) {
            owner.reset();
        }

        match book.fail_turn(cut, &format!("the event stream was cut: {reason}")) {
            Ok(true) => {}
            Ok(false) => {
                log::warn!("kap asked for a resync of a session with no turn in flight: {envelope}");
            }
            Err(error) => log::error!("could not close a turn whose stream was cut: {error}"),
        }

        return;
    }

    let Some(session_id) = envelope.get("session_id").and_then(Value::as_str) else {
        return;
    };

    // 位置由 kap 签发（信封上的 seq，跨守护进程重启有效）。此前它只被用来判一下
    // 「这是不是一帧事件」随后丢掉，于是重新订阅时说不出从哪儿接着发。
    let Some(seq) = envelope.get("seq").and_then(Value::as_i64) else {
        return;
    };

    let Some(payload) = envelope.get("payload") else {
        return;
    };

    let event_type = payload.get("type").and_then(Value::as_str).unwrap_or("");

    if event_type != kind {
        return;
    }

    // 认下来的每一帧事件都成帧进录制器 —— 判据在上面，这里不再问第二遍。
    if let Ok(Some(slot)) = book.slot(session_id) {
        let frame = kap_event(payload.clone());
        slot.record(|recorder| recorder.record_frame(frame));
    }

    match event_type {
        // 轮次结束：收掉这一轮的记录器，没答的审批与没答的题都作废，终帧殿后。
        "event.session.work_changed" => {
            /* work_changed 是会话活动投影，不是轮终错误通道。busy=false 只说明聚合已
            空闲；正式结果由 main agent 的 turn.ended 携带。这里仅在聚合落定后推进
            durable cursor，让同轮稍后到达的 error 事件也包含在续订水位内。 */
            if payload.get("busy").and_then(Value::as_bool) == Some(false) {
                let _sent = events_tx.unbounded_send(SessionEvent::Cursor {
                    session_id: session_id.to_owned(),
                    cursor: Cursor {
                        seq,
                        epoch: envelope
                            .get("epoch")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                    },
                });
            }
        }

        "turn.ended" => {
            let is_main_turn = payload.get("agentId").and_then(Value::as_str) == Some("main");

            if is_main_turn {
                let reason = payload
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("invalid");
                if let Some(owner) = owners.get(session_id) {
                    owner.reset();
                }

                let ended = match reason {
                    /* 这是状态终帧；用户可见错误来自前一帧 turn.ended.error。 */
                    "completed" | "cancelled" | "failed" | "blocked" => {
                        book.finish_turn(session_id, reason)
                    }
                    unknown => book.fail_turn(
                        session_id,
                        &format!("KAP turn.ended carried an unknown reason: {unknown}"),
                    ),
                };

                if let Err(error) = ended {
                    log::error!("could not close the turn kap just ended: {error}");
                }
            }
        }

        "agent.status.updated" => {
            // 仪表值是 volatile 信号（不进帧日志）：到达即替换。同一帧还挂着这条
            // 会话累计的输入构成（usage.total，kap events-zod.ts），三格计数与读数
            // 在同一次取走 —— 这条协议知识全程只有这一处。
            if let (Some(used), Some(size)) = (
                payload.get("contextTokens").and_then(Value::as_u64),
                payload.get("maxContextTokens").and_then(Value::as_u64),
            ) {
                let total = payload.get("usage").and_then(|usage| usage.get("total"));
                let counter = |key: &str| {
                    total
                        .and_then(|t| t.get(key))
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                };

                let _sent = events_tx.unbounded_send(SessionEvent::Usage {
                    session_id: session_id.to_owned(),
                    usage: json!({
                        "contextTokens": used,
                        "maxContextTokens": size,
                        "inputOther": counter("inputOther"),
                        "inputCacheRead": counter("inputCacheRead"),
                        "inputCacheCreation": counter("inputCacheCreation"),
                    }),
                });
            }

            // 卡在人这一侧：审批清单与提问清单都不随事件来（phase 里那格
            // approval 是 unknown），权威在 REST。
            //
            // 两个态都拉两张表。phase 是派生值，而它的优先级里审批高于提问
            // （agent-core-v2 的 rw-model-design.md：先看有没有 approval，再看有
            // 没有 question）。只在 awaiting_question 时去拉题，一旦同一条会话上
            // 还挂着一个没答的审批，phase 就永远报 awaiting_approval —— 那组题
            // 永远拉不到，agent 死等到轮次超时。反向同理。
            let phase = payload
                .get("phase")
                .and_then(|phase| phase.get("kind"))
                .and_then(Value::as_str)
                .unwrap_or("");

            if matches!(phase, "awaiting_approval" | "awaiting_question") {
                owners
                    .entry(session_id.to_owned())
                    .or_insert_with(|| {
                        ReconcileOwner::spawn(
                            session_id.to_owned(),
                            http.clone(),
                            base_url.to_owned(),
                            book.clone(),
                            desk.clone(),
                            questions.clone(),
                        )
                    })
                    .poll();
            }
        }

        _ => {}
    }
}

/// 给这条会话绑上模型。
///
/// 新开的会话没有模型：POST /sessions 的 body 里就没有这一格
/// （createSessionRequestSchema 只收 title / metadata / workspace_id），服务器建完
/// 会话回的 agent_config.model 是写死的空串（routes/sessions.ts 的 toWireSession）。
/// 而 agent 走第一步就要模型，没有就是 [model.not_configured] Model not set —— 一句
/// 话都答不出来，回合以 turn.ended reason=failed 收场。
///
/// 全局默认模型是 config 域的一个值（GET /config 的 default_model），会话不继承它：
/// 绑上去是开会话这一方的活，kap 只给了 POST /sessions/{id}/profile 这一个入口
/// （applySessionAgentConfig → IAgentProfileService.setModel，空串会被它跳过）。
///
/// 判据全部来自服务器：生效值问 status，默认值问 /config。本 crate 另有一条读
/// config.toml 的路（credentials.rs），那是装配阶段判断「这个别名有没有可用凭据」
/// 的本地对照，不是这里的依据 —— 同一件事有两个说法，迟早对不上。
///
/// 已经有模型的会话原样不动：装载与分叉带回来的选择是用户的，不是我们的。
///
/// 绑不上不在这里判死。握手一失败，界面连让用户改模型的地方都没有了；原因写进
/// 日志，真回合会带着 agent 自己的原话失败（run_failed 的 message）。
async fn ensure_model(http: &reqwest::Client, base_url: &str, session_id: &str) {
    let status = match get(http, &format!("{base_url}/sessions/{session_id}/status")).await {
        Ok(status) => status,
        Err(error) => {
            log::warn!("could not read the session's model: {error}");
            return;
        }
    };

    if status
        .get("model")
        .and_then(Value::as_str)
        .is_some_and(|model| !model.is_empty())
    {
        return;
    }

    let config = match get(http, &format!("{base_url}/config")).await {
        Ok(config) => config,
        Err(error) => {
            log::warn!("could not read the default model: {error}");
            return;
        }
    };

    let Some(default_model) = config
        .get("default_model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|alias| !alias.is_empty())
    else {
        log::warn!(
            "this kimi has no default model configured, so the session stays without one and every turn ends in model.not_configured"
        );
        return;
    };

    if let Err(error) = post(
        http,
        &format!("{base_url}/sessions/{session_id}/profile"),
        &json!({ "agent_config": { "model": default_model } }),
    )
    .await
    {
        log::warn!("could not set the session's model to {default_model}: {error}");
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
    pending: &mut HashSet<String>,
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

    let items = data
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    for item in items {
        let Some(approval_id) = item
            .get("approval_id")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            continue;
        };

        // 同一个审批会随每一份 agent.status.updated 再报一次：桌上已经有了的
        // 不记第二帧、不等第二份答案。
        if pending.contains(&approval_id) {
            continue;
        }

        if let Ok(Some(slot)) = book.slot(session_id) {
            slot.record(|recorder| {
                recorder.record_permission_requested_kap(
                    &approval_id,
                    item.get("tool_call_id")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                    item.get("tool_name").and_then(Value::as_str).unwrap_or(""),
                    &item,
                );
            });
        }

        let Ok(answer_rx) = desk.wait_kap(&approval_id) else {
            continue;
        };

        let _inserted = pending.insert(approval_id.clone());

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

            let answer = match decision.scope() {
                Some(scope) => {
                    json!({ "decision": decision.on_wire(), "scope": scope.on_wire() })
                }
                None => json!({ "decision": decision.on_wire() }),
            };

            let url = format!("{base2}/sessions/{sid}/approvals/{approval_id}");

            if let Err(error) = post(&http2, &url, &answer).await {
                log::warn!("could not deliver the approval answer: {error}");
            }

            if let Ok(Some(slot)) = book2.slot(&sid) {
                slot.record(|recorder| {
                    recorder.record_permission_resolved_kap(&approval_id, decision);
                });
            }
        });
    }
}

/// 撤下成功时信封里的 code。
///
/// 官方用一个非零码宣告成功：撤下这一路回的是
/// { code: QUESTION_DISMISSED, data: { dismissed: true, dismissed_at } }
/// （routes/questions.ts 的 dismiss 分支；error-codes.ts 里它是 40909）。不按码
/// 判，每一次成功的撤下都会被记成一次失败。
const QUESTION_DISMISSED: i64 = 40909;

/// 把一组题的收场送回 kap。
///
/// 两个动作同一条路由，靠动作后缀分路：POST …/questions/{id} 是回答，
/// POST …/questions/{id}:dismiss 是撤下（routes/questions.ts 的 parseActionSuffix：
/// allowedActions 只有 dismiss，默认 resolve）。
///
/// 错误不带 KapError 出来 —— 这里只有一个调用者，它要的就是一句能写进日志与帧
/// 的话。
async fn settle_question(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
    question_id: &str,
    outcome: &QuestionOutcome,
) -> core::result::Result<(), String> {
    let (url, body) = match outcome {
        QuestionOutcome::Answered(response) => (
            format!("{base_url}/sessions/{session_id}/questions/{question_id}"),
            response.on_wire(),
        ),
        QuestionOutcome::Dismissed => (
            format!("{base_url}/sessions/{session_id}/questions/{question_id}:dismiss"),
            json!({}),
        ),
    };

    let envelope: Value = http
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .json()
        .await
        .map_err(|error| error.to_string())?;

    match envelope_data(&envelope) {
        Ok(_accepted) => Ok(()),
        Err(KapError::Envelope { code, .. })
            if code == QUESTION_DISMISSED && matches!(outcome, QuestionOutcome::Dismissed) =>
        {
            Ok(())
        }
        Err(error) => Err(error.to_string()),
    }
}

/// agent 报它卡在人这一侧时，把这条会话挂着的题组逐个请上桌。
///
/// status=pending 是必填 query（rest-question.ts 的
/// listPendingQuestionsQuerySchema），不带它服务器回 40001。
async fn fetch_and_record_questions(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
    pending: &mut HashSet<String>,
    book: &SessionBook,
    desk: &QuestionDesk,
) {
    let url = format!("{base_url}/sessions/{session_id}/questions?status=pending");

    let data = match get(http, &url).await {
        Ok(data) => data,
        Err(error) => {
            log::warn!("could not list the pending questions: {error}");
            return;
        }
    };

    let items = data
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    for item in items {
        let Some(group) = QuestionGroup::from_wire(&item) else {
            log::warn!("a pending question group could not be read: {item}");
            continue;
        };

        // 同一组题会随每一份 agent.status.updated 再报一次：桌上已经有了的不记
        // 第二帧、不等第二份答案。
        if pending.contains(&group.question_id) {
            continue;
        }

        if let Ok(Some(slot)) = book.slot(session_id) {
            slot.record(|recorder| recorder.record_questions_asked(&group));
        }

        let Ok(answer_rx) = desk.wait(group.clone()) else {
            continue;
        };

        let _inserted = pending.insert(group.question_id.clone());

        let http2 = http.clone();
        let base2 = base_url.to_owned();
        let sid = session_id.to_owned();
        let book2 = book.clone();

        tokio::spawn(async move {
            // 发送端被丢掉只有一种情形：这一轮已经结束了（turn.ended 把它从桌上
            // 放掉了）。那时这不再是我们该回答的问题 —— 什么都不发。
            let Ok(outcome) = answer_rx.await else {
                return;
            };

            let delivered =
                match settle_question(&http2, &base2, &sid, &group.question_id, &outcome).await {
                    Ok(()) => true,
                    Err(error) => {
                        log::warn!("could not deliver the question answer: {error}");
                        false
                    }
                };

            if let Ok(Some(slot)) = book2.slot(&sid) {
                slot.record(|recorder| {
                    recorder.record_questions_resolved(&group, &outcome, delivered);
                });
            }
        });
    }
}

// ── 会话的 REST 辅助 ───────────────────────────────────────────────────────

async fn submit_prompt(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
    text: &str,
    images: &[PromptImage],
    skills: &[PromptSkill],
) -> Result<String> {
    let body = prompt_body(text, images, skills)?;
    let data = post(
        http,
        &format!("{base_url}/sessions/{session_id}/prompts"),
        &body,
    )
    .await?;
    data.get("prompt_id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| KapError::Transport {
            message: format!("no prompt_id in prompt response: {data}"),
        })
}

fn prompt_body(text: &str, images: &[PromptImage], skills: &[PromptSkill]) -> Result<Value> {
    let mut content = Vec::new();
    if !text.is_empty() {
        content.push(json!({ "type": "text", "text": text }));
    }
    for image in images {
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
        return Err(KapError::Validation {
            message: "prompt has no content".to_owned(),
        });
    }
    let activations: Vec<Value> = skills
        .iter()
        .map(
            |skill| match skill.args.as_deref().filter(|args| !args.is_empty()) {
                Some(args) => json!({ "name": skill.name, "args": args }),
                None => json!({ "name": skill.name }),
            },
        )
        .collect();
    if activations.is_empty() {
        Ok(json!({ "content": content }))
    } else {
        Ok(json!({ "content": content, "skills": activations }))
    }
}

async fn open_session(
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

    let id = data
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| KapError::Transport {
            message: format!("no session id in POST /sessions response: {data}"),
        })?
        .to_owned();

    book.open(&id)?;
    subscribe(ws, &id, None).await?;

    ensure_model(http, base_url, &id).await;

    let selectors = best_effort_selectors(http, base_url, &id).await;

    Ok(OpenedSession {
        session_id: id,
        selectors,
    })
}

/// kap 的会话在 server 侧持久：装载 = 验存在 + 重新订阅。号在 server 侧也没了
/// 时，GET 的信封带非零 code，在这里变成 Err —— 调用侧据此走 Forgotten 路径
/// （桌面 seam 的 addressing.rs）。
async fn load_session(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
    from: Option<&Cursor>,
    book: &SessionBook,
    ws: &WsSink,
) -> Result<OpenedSession> {
    get(http, &format!("{base_url}/sessions/{session_id}")).await?;

    book.open(session_id)?;
    subscribe(ws, session_id, from).await?;

    ensure_model(http, base_url, session_id).await;

    let selectors = best_effort_selectors(http, base_url, session_id).await;

    Ok(OpenedSession {
        session_id: session_id.to_owned(),
        selectors,
    })
}

async fn fork_session(
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

    let id = data
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| KapError::Transport {
            message: format!("no session id in fork response: {data}"),
        })?
        .to_owned();

    book.open(&id)?;
    subscribe(ws, &id, None).await?;

    ensure_model(http, base_url, &id).await;

    let selectors = best_effort_selectors(http, base_url, &id).await;

    Ok(OpenedSession {
        session_id: id,
        selectors,
    })
}

async fn archive_session(
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

async fn list_sessions(http: &reqwest::Client, base_url: &str) -> Result<Vec<SessionEntry>> {
    let data = get(http, &format!("{base_url}/sessions")).await?;

    let items = data
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    Ok(items
        .iter()
        .filter_map(|item| {
            let id = item.get("id").and_then(Value::as_str)?.to_owned();
            let title = item.get("title").and_then(Value::as_str).map(str::to_owned);
            let updated_at = item
                .get("updated_at")
                .and_then(Value::as_str)
                .map(str::to_owned);
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
    match get_selectors(http, base_url, session_id).await {
        Ok(offered) => offered,
        Err(error) => {
            log::warn!("could not read the session's selectors: {error}");
            Vec::new()
        }
    }
}

/// 这条会话能用的技能（rest-skill.ts 的 listSkillsResponseSchema）。
async fn list_skills(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
) -> Result<Vec<Skill>> {
    let data = get(http, &format!("{base_url}/sessions/{session_id}/skills")).await?;

    let listed = data
        .get("skills")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    Ok(listed
        .iter()
        .filter_map(|item| {
            Some(Skill {
                name: item.get("name").and_then(Value::as_str)?.to_owned(),
                description: item
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                source: item
                    .get("source")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
            })
        })
        .collect())
}

async fn list_mcp_servers(http: &reqwest::Client, base_url: &str) -> Result<Vec<McpServer>> {
    let data = get(http, &format!("{base_url}/mcp/servers")).await?;
    let listed = data
        .get("servers")
        .and_then(Value::as_array)
        .ok_or_else(|| KapError::Transport {
            message: "MCP response has no servers array".to_owned(),
        })?;
    listed
        .iter()
        .map(|item| {
            let required = |key: &str| {
                item.get(key)
                    .and_then(Value::as_str)
                    .ok_or_else(|| KapError::Transport {
                        message: format!("MCP server has no {key}: {item}"),
                    })
            };
            let transport = match required("transport")? {
                "stdio" => McpTransport::Stdio,
                "http" => McpTransport::Http,
                "sse" => McpTransport::Sse,
                other => {
                    return Err(KapError::Transport {
                        message: format!("unknown MCP transport {other}"),
                    });
                }
            };
            let status = match required("status")? {
                "connected" => McpStatus::Connected,
                "connecting" => McpStatus::Connecting,
                "disconnected" => McpStatus::Disconnected,
                "error" => McpStatus::Error,
                other => {
                    return Err(KapError::Transport {
                        message: format!("unknown MCP status {other}"),
                    });
                }
            };
            let count = item
                .get("tool_count")
                .and_then(Value::as_u64)
                .ok_or_else(|| KapError::Transport {
                    message: format!("MCP server has no tool_count: {item}"),
                })?;
            Ok(McpServer {
                id: required("id")?.to_owned(),
                name: required("name")?.to_owned(),
                transport,
                status,
                tool_count: u32::try_from(count).map_err(|_| KapError::Transport {
                    message: format!("MCP tool_count is too large: {count}"),
                })?,
                last_error: item
                    .get("last_error")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            })
        })
        .collect()
}

async fn abort_session(http: &reqwest::Client, base_url: &str, session_id: &str) -> Result<()> {
    post(
        http,
        &format!("{base_url}/sessions/{session_id}:abort"),
        &json!({}),
    )
    .await?;
    Ok(())
}

async fn get_selectors(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
) -> Result<Vec<ConfigControl>> {
    let status = get(http, &format!("{base_url}/sessions/{session_id}/status")).await?;
    let catalog = get(http, &format!("{base_url}/models")).await?;
    let goal = get(http, &format!("{base_url}/sessions/{session_id}/goal")).await?;
    Ok(controls(&status, &catalog, &goal))
}

async fn set_selector(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
    config_id: &str,
    value: &str,
    input: Option<&str>,
) -> Result<Vec<ConfigControl>> {
    let current = get_selectors(http, base_url, session_id).await?;
    let control = current
        .iter()
        .find(|control| control.id == config_id)
        .ok_or_else(|| KapError::Validation {
            message: format!("the session offers no control {config_id}"),
        })?;
    if control.current == value {
        return Ok(current);
    }
    if !control.choices.iter().any(|choice| choice.value == value) {
        return Err(KapError::Validation {
            message: format!("control {config_id} does not offer {value}"),
        });
    }
    let patch = selector_patch(config_id, value, input)?;
    post(
        http,
        &format!("{base_url}/sessions/{session_id}/profile"),
        &json!({ "agent_config": patch }),
    )
    .await?;
    get_selectors(http, base_url, session_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_skills_share_one_prompt_and_never_send_a_client_prompt_id() {
        let body = prompt_body(
            "review this",
            &[],
            &[PromptSkill {
                name: "research".to_owned(),
                args: None,
            }],
        )
        .expect("prompt body");
        assert!(body.get("prompt_id").is_none());
        assert_eq!(
            body.get("skills").and_then(Value::as_array).map(Vec::len),
            Some(1)
        );
        assert_eq!(
            body.get("content").and_then(Value::as_array).map(Vec::len),
            Some(1)
        );
    }

    #[test]
    fn reconciliation_batch_preserves_reset_order() {
        let mut batch = ReconcileBatch::default();
        batch.push(ReconcileMessage::Poll);
        batch.push(ReconcileMessage::Poll);
        batch.push(ReconcileMessage::Reset);

        assert_eq!(
            batch,
            ReconcileBatch {
                poll: false,
                reset: true
            }
        );

        batch.push(ReconcileMessage::Poll);
        assert_eq!(
            batch,
            ReconcileBatch {
                poll: true,
                reset: true
            }
        );
    }
}
