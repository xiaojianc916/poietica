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
//! 同名 type、agentId 与 sessionId。没有哪一帧的 type 是 "session_event"：
//! wire 上事件帧的 type 字段就是事件自己的类型名（契约快照钉在
//! contracts/kap/asyncapi.json）。
//!
//! 数据流：
//!   命令 → Command 枚举 → REST（sessions / prompts / approvals / profile）或
//!   WS 控制帧（subscribe / abort / pong）
//!   事件 → WS 事件帧（type 即事件类型）→ frame.rs 的 kap_event() → RecordedEvent → Tauri
//!
//! 协议事实来源是 MoonshotAI/kimi-code 的 packages/kap-server（routes/ 与
//! protocol/ 两个目录），快照钉在 contracts/kap。信封约定
//! { code, msg, data, request_id }：业务成败看 code，不看 HTTP 状态。

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
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

use crate::commands::{AgentClient, Command, PromptAttachment, PromptSkill};
use crate::config::{ConfigControl, GoalSnapshot, controls, goal_snapshot, selector_patch};
use crate::desk::{PermissionDesk, QuestionDesk};
use crate::error::{KapError, Refusal, Result};
use crate::frame::kap_event;
use crate::link::{RELINK_TRIES, backoff, recovered, retrying, severed};
use crate::program::{hide_console, resolve_program};
use crate::question::{QuestionGroup, QuestionOutcome};
use crate::recorder::{Recorder, now_millis};
use crate::run_slot::RunSlot;
use crate::session::{
    AgentConnection, AgentSpawn, Cursor, Handshake, McpServer, McpStatus, McpTransport,
    OpenedSession, SessionEntry, SessionEvent, SessionEvents, SessionUsageSnapshot, Skill,
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

/// 一帧控制帧的 ack 最多等多久。
///
/// 对端接下 TCP 却不说话时，裸等会让首连的握手与每一次重连各自永远停住 ——
/// 屏幕上那一行既不 Recovered 也不 Severed。
const ACK_TIMEOUT: Duration = Duration::from_secs(10);

/// 拨一条 WS。令牌走 Authorization 头，与 REST 同一条鉴权。
async fn dial_ws(ws_url: &str, auth: &reqwest::header::HeaderValue) -> Result<WsStream> {
    let mut request = ws_url
        .into_client_request()
        .map_err(|e| KapError::Transport {
            message: e.to_string(),
        })?;

    request.headers_mut().insert(AUTHORIZATION, auth.clone());

    let (stream, _response) = connect_async(request)
        .await
        .map_err(|e| KapError::Handshake {
            message: e.to_string(),
        })?;

    Ok(stream)
}

/// server_hello → client_hello → ack。首连与重连共用这一条。
async fn shake_hands(
    ws: &WsSink,
    ws_rx: &mut SplitStream<WsStream>,
    stash: &mut Vec<Value>,
) -> Result<()> {
    let deadline = tokio::time::Instant::now() + ACK_TIMEOUT;

    loop {
        match tokio::time::timeout_at(deadline, ws_rx.next()).await {
            Ok(Some(Ok(Message::Text(raw)))) => {
                if let Ok(frame) = serde_json::from_str::<Value>(&raw)
                    && frame.get("type").and_then(Value::as_str) == Some("server_hello")
                {
                    break;
                }
            }
            Ok(Some(Err(error))) => {
                return Err(KapError::Handshake {
                    message: error.to_string(),
                });
            }
            Ok(None) => {
                return Err(KapError::Handshake {
                    message: "WS closed before server_hello".to_owned(),
                });
            }
            Err(_elapsed) => {
                return Err(KapError::Handshake {
                    message: "no server_hello arrived in time".to_owned(),
                });
            }
            Ok(_) => {}
        }
    }

    let hello = send_frame(
        ws,
        "client_hello",
        json!({ "client_id": Uuid::new_v4().to_string() }),
    )
    .await?;

    let _accepted = wait_ack(ws_rx, &hello, stash).await?;

    Ok(())
}

/// 一次重连接回来的东西：补投的帧，以及 server 不再认的那几条会话。
struct Relinked {
    stash: Vec<Value>,
    refused: Vec<String>,
}

/// 一次重连：拨、握手、把册子上每条会话按它读到的位置挂回去。
///
/// 单条会话没订上不是链路的事（归档、换纪元、server 侧已不在）：它进 refused，
/// 链路照活；传输错才向上报。
async fn redial(
    ws: &WsSink,
    ws_rx: &mut SplitStream<WsStream>,
    ws_url: &str,
    auth: &reqwest::header::HeaderValue,
    book: &SessionBook,
    cursors: &HashMap<String, Cursor>,
) -> Result<Relinked> {
    let (sink, rx) = dial_ws(ws_url, auth).await?.split();

    /* 写端在锁后面，换的是锁里那一个：已经拿着 Arc 的那些任务不必知道链路换过。 */
    *ws.lock().await = sink;
    *ws_rx = rx;

    let mut stash: Vec<Value> = Vec::new();

    shake_hands(ws, ws_rx, &mut stash).await?;

    let mut refused: Vec<String> = Vec::new();

    for session_id in book.ids()? {
        let again = subscribe(ws, &session_id, cursors.get(&session_id)).await?;

        if !wait_subscribe_ack(ws_rx, &again, &session_id, &mut stash).await? {
            refused.push(session_id);
        }
    }

    Ok(Relinked { stash, refused })
}

/// 把断了的链路接回来，并把进度报上去。
///
/// 有界重试 + 指数退避，判据与退避都在 link.rs。交回 Some 是接上了（里面是重连
/// 期间到达的帧，以及 server 不再认的那几条会话），None 是到顶了 —— 那时链路态
/// 封成 Severed，这一轮的结局仍由调用者按帧记下。
async fn relink(
    ws: &WsSink,
    ws_rx: &mut SplitStream<WsStream>,
    ws_url: &str,
    auth: &reqwest::header::HeaderValue,
    book: &SessionBook,
    cursors: &HashMap<String, Cursor>,
    events_tx: &mpsc::UnboundedSender<SessionEvent>,
    cause: &str,
) -> Option<Relinked> {
    let mut reason = cause.to_owned();

    for attempt in 1..=RELINK_TRIES {
        /* 第一次立刻拨：退避是失败之间的间隔，不是第一次的入场费。 */
        let wait = if attempt == 1 {
            Duration::ZERO
        } else {
            backoff(attempt - 1)
        };

        let _sent = events_tx.unbounded_send(SessionEvent::Link(retrying(attempt, wait, &reason)));

        tokio::time::sleep(wait).await;

        match redial(ws, ws_rx, ws_url, auth, book, cursors).await {
            Ok(relinked) => {
                let _sent = events_tx.unbounded_send(SessionEvent::Link(recovered(&reason)));

                return Some(relinked);
            }
            Err(error) => {
                log::warn!("kap WS relink {attempt}/{RELINK_TRIES} failed: {error}");
                reason = error.to_string();
            }
        }
    }

    /* 这一轮就此封版：屏幕上那一行不再许诺下一次。 */
    let _sent = events_tx.unbounded_send(SessionEvent::Link(severed(RELINK_TRIES, &reason)));

    None
}

/// 链路接不回来了：在飞的每一轮按帧判死，屏幕上那个纺锤才停得下来。
fn fail_in_flight(book: &SessionBook, reason: &str) {
    let Ok(ids) = book.ids() else {
        log::error!("the session book is poisoned, so no turn could be closed");
        return;
    };

    let message = format!("the link went down and could not be brought back: {reason}");

    for id in ids {
        if let Err(error) = book.fail_turn(&id, &message) {
            log::error!("could not close the turn of a severed session: {error}");
        }
    }
}

// ── 实例注册表 ─────────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct InstanceDisk {
    host: String,
    port: u16,
    /// 注册时刻（epoch 毫秒，server 写文件的 Date.now()），与本机同一个钟。
    started_at: i64,
}

impl InstanceDisk {
    fn eligible(content: &str, not_before: i64) -> Option<Self> {
        serde_json::from_str(content)
            .ok()
            .filter(|registration: &Self| registration.started_at >= not_before)
    }
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
                    && let Some(info) = InstanceDisk::eligible(&content, not_before)
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

        let mut command = tokio::process::Command::new("taskkill");
        command.args(["/PID", pid_text.as_str(), "/T", "/F"]);
        hide_console(command.as_std_mut());
        let _tree = command.output().await;
    }

    child.kill().await.ok();
}

/// 这条连接起的那个进程，谁起谁埋。
///
/// Drop 里补刀是为了不经过 Shutdown 的退场（握手失败、册子中毒、链路接不回来）：
/// tokio 的 Child 不随句柄一起死，漏一次就在这台机器上留一个占着端口与 home 的
/// kap server。
struct Spawned(tokio::process::Child);

impl Drop for Spawned {
    fn drop(&mut self) {
        /* Windows 上拉起的是转发脚本，server 是它的子进程：单杀它会把 server
        漏下，与 kill_tree 同一个理由。Drop 里不能 await，收尸交给系统。 */
        if cfg!(windows)
            && let Some(pid) = self.0.id()
        {
            let mut reaper = std::process::Command::new("taskkill");

            reaper.args(["/PID", &pid.to_string(), "/T", "/F"]);
            hide_console(&mut reaper);

            let _tree = reaper.spawn();
        }

        let _killed = self.0.start_kill();
    }
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
/// 一个样：{ type, id, payload }（contracts/kap/asyncapi.json 的控制面操作）。
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
    let deadline = tokio::time::Instant::now() + ACK_TIMEOUT;

    loop {
        match tokio::time::timeout_at(deadline, ws_rx.next()).await {
            Ok(Some(Ok(Message::Text(raw)))) => {
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
            Ok(Some(Err(error))) => {
                return Err(KapError::Handshake {
                    message: error.to_string(),
                });
            }
            Ok(None) => {
                return Err(KapError::Handshake {
                    message: "WS closed before the ack arrived".to_owned(),
                });
            }
            Err(_elapsed) => {
                return Err(KapError::Handshake {
                    message: format!("control frame {id} was never acknowledged"),
                });
            }
            Ok(_) => {}
        }
    }
}

/// 订阅的 ack 永远是 code 0：成败写在载荷的 accepted / not_found 里
/// （contracts/kap/asyncapi.json 的 subscribe_ack）。
/// 只看 code 就会把「这条会话没订上」当成订上了，然后一帧不来地等到超时。
/// Ok(false) 是「这条会话没订上」，一条会话的事；Err 是这条链路的事。
async fn wait_subscribe_ack(
    ws_rx: &mut SplitStream<WsStream>,
    id: &str,
    session_id: &str,
    stash: &mut Vec<Value>,
) -> Result<bool> {
    let payload = wait_ack(ws_rx, id, stash).await?;

    Ok(payload
        .get("accepted")
        .and_then(Value::as_array)
        .is_some_and(|ids| ids.iter().any(|entry| entry.as_str() == Some(session_id))))
}

/// 把一条会话挂到这条连接的事件流上，返回那一帧的 id。不在握手内联订阅：
/// 订阅走独立的 subscribe 操作（contracts/kap/asyncapi.json 的 subscribe）。
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

struct PromptJob {
    text: String,
    attachments: Vec<PromptAttachment>,
    skills: Vec<PromptSkill>,
    reply: oneshot::Sender<Result<String>>,
}

enum PromptOwnerMessage {
    Submit(PromptJob),
    TurnEnded,
}

struct PromptOwner {
    messages: mpsc::UnboundedSender<PromptOwnerMessage>,
    task: tokio::task::JoinHandle<()>,
}

impl PromptOwner {
    fn spawn(
        session_id: String,
        http: reqwest::Client,
        base_url: String,
        book: SessionBook,
    ) -> Self {
        let (messages, mut incoming) = mpsc::unbounded();
        let task = tokio::spawn(async move {
            let mut pending = VecDeque::<PromptJob>::new();
            let mut active = false;

            while let Some(message) = incoming.next().await {
                match message {
                    PromptOwnerMessage::Submit(job) => pending.push_back(job),
                    PromptOwnerMessage::TurnEnded => active = false,
                }

                while !active {
                    let Some(job) = pending.pop_front() else {
                        break;
                    };
                    let result = submit_prompt(
                        &http,
                        &base_url,
                        &session_id,
                        &job.text,
                        &job.attachments,
                        &job.skills,
                    )
                    .await;
                    active = result.is_ok();
                    if let Err(error) = &result
                        && let Err(closing) = book.fail_turn(&session_id, &error.to_string())
                    {
                        log::error!("could not close a rejected admission: {closing}");
                    }
                    let _sent = job.reply.send(result);
                }
            }
        });
        Self { messages, task }
    }

    fn send(&self, message: PromptOwnerMessage) {
        if self.messages.unbounded_send(message).is_err() {
            log::error!("prompt owner stopped unexpectedly");
        }
    }
}

impl Drop for PromptOwner {
    fn drop(&mut self) {
        self.task.abort();
    }
}

struct PromptCoordinator {
    owners: HashMap<String, PromptOwner>,
    http: reqwest::Client,
    base_url: String,
    book: SessionBook,
}

impl PromptCoordinator {
    fn new(http: reqwest::Client, base_url: String, book: SessionBook) -> Self {
        Self {
            owners: HashMap::new(),
            http,
            base_url,
            book,
        }
    }

    fn submit(&mut self, session_id: &str, job: PromptJob) {
        self.owners
            .entry(session_id.to_owned())
            .or_insert_with(|| {
                PromptOwner::spawn(
                    session_id.to_owned(),
                    self.http.clone(),
                    self.base_url.clone(),
                    self.book.clone(),
                )
            })
            .send(PromptOwnerMessage::Submit(job));
    }

    /// 这条会话没了，它的排队者跟着走：队列的事实在 agent 那侧，本地留一个没有
    /// 对端的排队者只会攒住那几个没人来取的答复。
    fn forget(&mut self, session_id: &str) {
        let _stopped = self.owners.remove(session_id);
    }

    fn turn_ended(&self, session_id: &str) {
        if let Some(owner) = self.owners.get(session_id) {
            owner.send(PromptOwnerMessage::TurnEnded);
        }
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
        home: home_dir,
    } = spawn;

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
        let mut command = tokio::process::Command::new(&resolved);
        command
            .args(&args)
            .current_dir(&cwd)
            .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped());
        hide_console(command.as_std_mut());

        let mut child = Spawned(command.spawn().map_err(|e| KapError::Spawn {
            message: e.to_string(),
        })?);

        // stderr 日志透传
        let diag_stderr = diagnostics.clone();
        if let Some(stderr) = child.0.stderr.take() {
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
                kill_tree(&mut child.0).await;

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

        // 6. WebSocket 握手。首连与重连走同一个 dial_ws / shake_hands。
        let ws_url = format!("ws://{dial}:{port}/api/v1/ws");

        let ws_stream = match dial_ws(&ws_url, &auth_header).await {
            Ok(stream) => stream,
            Err(error) => {
                let _ = ready_tx.send(Err(KapError::Handshake {
                    message: error.to_string(),
                }));
                return Err(error);
            }
        };

        let (ws_sink, mut ws_rx) = ws_stream.split();
        let ws: WsSink = Arc::new(tokio::sync::Mutex::new(ws_sink));

        // 等 ack 期间到达的事件帧先收着，主循环开张前补投。
        let mut stash: Vec<Value> = Vec::new();

        if let Err(error) = shake_hands(&ws, &mut ws_rx, &mut stash).await {
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

        /* 锚会话是这条连接自己的地址：它没订上，这条连接就没有能问话的会话。 */
        match wait_subscribe_ack(&mut ws_rx, &anchor_sub, &session_id, &mut stash).await {
            Ok(true) => {}
            Ok(false) => {
                let refused = KapError::Handshake {
                    message: format!("the server did not subscribe the anchor {session_id}"),
                };

                let _ = ready_tx.send(Err(KapError::Handshake {
                    message: refused.to_string(),
                }));

                return Err(refused);
            }
            Err(error) => {
                let _ = ready_tx.send(Err(KapError::Handshake {
                    message: error.to_string(),
                }));

                return Err(error);
            }
        }

        let _ = ready_tx.send(Ok(Handshake {
            session_id: session_id.clone(),
        }));

        // 8. 主循环
        let mut router = EventRouter::new(
            book_clone.clone(),
            desk.clone(),
            questions.clone(),
            events_tx.clone(),
            http.clone(),
            base_url.clone(),
        );

        /* 每条会话最后读到的位置。重连按它续订：帧不重发，也不缺号。 */

        // 补投握手期间收下的帧。里面可能有一帧 ping 不必答：我们刚发出去的
        // client_hello 与 subscribe 已经刷新了服务端的 lastInboundAt，而它的
        // 判死线是连续两个周期没有任何入站帧（wsConnectionV1.ts onHeartbeat）。
        for envelope in std::mem::take(&mut stash) {
            router.handle(&envelope);
        }

        let mut commands_rx = commands_rx;
        let mut severed: Option<String> = None;

        loop {
            /* 链路断了：先接回来再往下读。到顶了这一轮判死，连接退场。 */
            if let Some(reason) = severed.take() {
                let Some(relinked) = relink(
                    &ws,
                    &mut ws_rx,
                    &ws_url,
                    &auth_header,
                    &book_clone,
                    router.cursors(),
                    &events_tx,
                    &reason,
                )
                .await
                else {
                    fail_in_flight(&book_clone, &reason);
                    break;
                };

                for session_id in relinked.refused {
                    router.forget(&session_id, "the server no longer serves this session");
                }

                for envelope in relinked.stash {
                    router.handle(&envelope);
                }
            }

            tokio::select! {
                cmd = commands_rx.next() => {
                    match cmd {
                        Some(Command::Shutdown(gone)) => {
                            kill_tree(&mut child.0).await;
                            /* 收尸完成才报：屏障等的就是这一声。 */
                            let _reported = gone.send(());
                            break;
                        }
                        /* 命令端全没了：没人再要收据，收尸照做。 */
                        None => {
                            kill_tree(&mut child.0).await;
                            break;
                        }

                        Some(Command::Steer {
                            session_id: sid,
                            prompt_ids,
                            reply,
                        }) => {
                            let http = http.clone();
                            let base = base_url.clone();

                            tokio::spawn(async move {
                                let _ = reply.send(
                                    queue_action(
                                        &http,
                                        &format!("{base}/sessions/{sid}/prompts:steer"),
                                        &json!({ "prompt_ids": prompt_ids }),
                                    )
                                    .await,
                                );
                            });
                        }

                        Some(Command::AbortPrompt {
                            session_id: sid,
                            prompt_id,
                            reply,
                        }) => {
                            let http = http.clone();
                            let base = base_url.clone();

                            tokio::spawn(async move {
                                let _ = reply.send(
                                    queue_action(
                                        &http,
                                        &format!("{base}/sessions/{sid}/prompts/{prompt_id}:abort"),
                                        &json!({}),
                                    )
                                    .await,
                                );
                            });
                        }
                        Some(Command::Cancel { session_id: sid, reply }) => {
                            let http2 = http.clone();
                            let base2 = base_url.clone();
                            let book2 = book_clone.clone();
                            /* 认下此刻在飞的那一轮：宽限期到时在飞的可能已经是下一轮。 */
                            let aborted = book2.ended_count(&sid).ok().flatten();
                            tokio::spawn(async move {
                                let result = abort_session(&http2, &base2, &sid).await;
                                let accepted = result.is_ok();
                                let _ = reply.send(result);

                                /* 请求本身没送出去时这一轮还在 agent 手上，
                                轮终仍由 turn.ended 说话。 */
                                if !accepted {
                                    return;
                                }

                                let Some(aborted) = aborted else {
                                    return;
                                };

                                tokio::time::sleep(CANCEL_GRACE).await;

                                match book2.finish_turn_since(&sid, "cancelled", aborted) {
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

                        Some(Command::ForkSession { session_id: src, drop_turns, reply }) => {
                            let http2 = http.clone();
                            let base2 = base_url.clone();
                            let book2 = book_clone.clone();
                            let ws2 = Arc::clone(&ws);
                            tokio::spawn(async move {
                                let result =
                                    fork_session(&http2, &base2, &src, drop_turns, &book2, &ws2)
                                        .await;
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

                        Some(Command::Prompt { session_id: sid, text, attachments, skills, frames, reply }) => {
                            let held = book_clone.slot(&sid).ok().flatten();
                            if let Some(slot) = held {
                                let admission_id = Uuid::new_v4().to_string();
                                let shown = attachments.iter().map(|item| item.url().to_owned()).collect();
                                let attached = skills.iter().map(|skill| skill.name.clone()).collect();
                                if slot.attach(|| Recorder::new(sid.clone(), slot.seq(), frames)).is_err() {
                                    let _sent = reply.send(Err(KapError::Poisoned));
                                    continue;
                                }
                                let mut durable = false;
                                let recorded = slot.record(|recorder| {
                                    durable = recorder.record_prompt_admitted(
                                        &admission_id,
                                        &text,
                                        shown,
                                        attached,
                                    );
                                });
                                if !recorded || !durable {
                                    let _sent = reply.send(Err(KapError::Transport {
                                        message: "the frame journal refused the prompt admission".to_owned(),
                                    }));
                                    continue;
                                }
                                router.submit(&sid, PromptJob { text, attachments, skills, reply });
                            } else {
                                let _sent = reply.send(Err(KapError::Refused(Refusal::UnknownSession)));
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
                                let result = get_selectors(&http2, &base2, &sid)
                                    .await
                                    .map(|(offered, _goal)| offered);
                                let _ = reply.send(result);
                            });
                        }

                        Some(Command::Goal { session_id: sid, reply }) => {
                            let http2 = http.clone();
                            let base2 = base_url.clone();
                            tokio::spawn(async move {
                                let _ = reply.send(fetch_goal(&http2, &base2, &sid).await);
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
                        None => severed = Some("the kap websocket closed".to_owned()),

                        Some(Err(error)) => {
                            log::warn!("kap WS error: {error}");
                            severed = Some(error.to_string());
                        }

                        Some(Ok(Message::Text(raw))) => {
                            if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                                if v.get("type").and_then(Value::as_str) == Some("ping") {
                                    // kap 的心跳是应用层帧（契约快照 contracts/kap/
                                    // asyncapi.json 的 ping/pong），与 tungstenite 的协议层
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
                                    router.handle(&v);
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

        drop(router);
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

struct EventRouter {
    owners: HashMap<String, ReconcileOwner>,
    book: SessionBook,
    desk: PermissionDesk,
    questions: QuestionDesk,
    events_tx: mpsc::UnboundedSender<SessionEvent>,
    http: reqwest::Client,
    base_url: String,
    cursors: HashMap<String, Cursor>,
    prompts: PromptCoordinator,
}

impl EventRouter {
    fn new(
        book: SessionBook,
        desk: PermissionDesk,
        questions: QuestionDesk,
        events_tx: mpsc::UnboundedSender<SessionEvent>,
        http: reqwest::Client,
        base_url: String,
    ) -> Self {
        let prompts = PromptCoordinator::new(http.clone(), base_url.clone(), book.clone());
        Self {
            owners: HashMap::new(),
            book,
            desk,
            questions,
            events_tx,
            http,
            base_url,
            cursors: HashMap::new(),
            prompts,
        }
    }

    fn cursors(&self) -> &HashMap<String, Cursor> {
        &self.cursors
    }

    fn submit(&mut self, session_id: &str, job: PromptJob) {
        self.prompts.submit(session_id, job);
    }

    /// 这条会话在 server 侧没有了：在飞的那一轮判死，读点作废，本地不再留任何
    /// 与它有关的所有权。链路与其余会话不受影响 —— 全仓只有这一处这条策略。
    fn forget(&mut self, session_id: &str, reason: &str) {
        log::warn!("kap no longer serves {session_id}: {reason}");

        if let Err(error) = self.book.fail_turn(session_id, reason) {
            log::error!("could not close the turn of a forgotten session: {error}");
        }

        let _dropped = self.cursors.remove(session_id);
        let _stopped = self.owners.remove(session_id);
        self.prompts.forget(session_id);

        let _sent = self.events_tx.unbounded_send(SessionEvent::CursorLost {
            session_id: session_id.to_owned(),
        });

        if let Err(error) = self.book.close(session_id) {
            log::error!("could not drop a forgotten session: {error}");
        }
    }

    fn handle(&mut self, envelope: &Value) {
        // 事件帧的 type 就是事件自己的 type（turn.ended / assistant.delta / …），
        // 不是字符串 "session_event"：wsEventEnvelopeSchema 里 type 是 z.string()，
        // sessionEventOperation 的 'session_event' 只是操作目录里那一条的名字。
        //
        // 判据：同时带 session_id、seq 和一个自带 type 的载荷，且两个 type 相等。
        // 控制帧与系统帧就此排除 —— 系统 error 帧的载荷是 { code, msg, fatal }，
        // 既没有 type 也没有 seq，不会被当成 agent 的 error 事件收进来。
        let kind = envelope.get("type").and_then(Value::as_str).unwrap_or("");

        // 订阅失败不写在 code 上：ack 永远回 0，落选的会话在载荷的 not_found 里。
        // 异步订阅（新开 / 装载 / 分叉）的 ack 只到得了这里，落选按会话收摊。
        if kind == "ack"
            && let Some(missing) = envelope
                .get("payload")
                .and_then(|payload| payload.get("not_found"))
                .and_then(Value::as_array)
                .map(|ids| {
                    ids.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect::<Vec<String>>()
                })
            && !missing.is_empty()
        {
            for refused in missing {
                self.forget(&refused, "the server refused to subscribe this session");
            }

            return;
        }

        let Self {
            owners,
            book,
            desk,
            questions,
            events_tx,
            http,
            base_url,
            cursors,
            prompts,
        } = self;

        // kap 说这条会话的事件流断了（reason 枚举 buffer_overflow / session_recreated /
        // epoch_changed，见 contracts/kap/asyncapi.json 的 resync_required 载荷）：断点
        // 之后的帧不会再来，这一轮的经过补不齐。判死它 —— 补不回来的东西不该装作还在路上。
        if kind == "resync_required" {
            let Some(cut) = envelope
                .get("payload")
                .and_then(|payload| payload.get("session_id"))
                .or_else(|| envelope.get("session_id"))
                .and_then(Value::as_str)
                .filter(|named| !named.is_empty())
            else {
                log::warn!("kap asked for a resync without naming a session");

                return;
            };

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

            /* 这一段流接不下去了，链路上那个位置同样作废。 */
            let _dropped = cursors.remove(cut);

            if let Some(owner) = owners.get(cut) {
                owner.reset();
            }

            match book.fail_turn(cut, &format!("the event stream was cut: {reason}")) {
                Ok(true) => {}
                Ok(false) => {
                    log::warn!(
                        "kap asked for a resync of a session with no turn in flight: {envelope}"
                    );
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

        /* 链路读到哪儿了，按帧记。它必须是「真的消费过的最后一帧」：拿轮终那个落库
        读点去续订，会让 kap 重发本轮已经记下的帧。 */
        let _moved = cursors.insert(
            session_id.to_owned(),
            Cursor {
                seq,
                epoch: envelope
                    .get("epoch")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            },
        );

        // 认下来的每一帧事件都成帧进录制器 —— 判据在上面，这里不再问第二遍。
        if let Ok(Some(slot)) = book.slot(session_id) {
            let frame = kap_event(payload.clone());
            slot.record(|recorder| recorder.record_frame(frame));
        }

        match event_type {
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

                    match ended {
                        Ok(_) => prompts.turn_ended(session_id),
                        Err(error) => {
                            log::error!("could not close the turn kap just ended: {error}");
                        }
                    }

                    /* 一轮落定，目标的轮数、用量与时长都变了：整表推一次。 */
                    let http2 = http.clone();
                    let base2 = base_url.to_owned();
                    let sid = session_id.to_owned();
                    let events2 = events_tx.clone();

                    tokio::spawn(async move {
                        let Ok((offered, goal)) = get_selectors(&http2, &base2, &sid).await else {
                            return;
                        };

                        let _sent = events2.unbounded_send(SessionEvent::Selectors {
                            session_id: sid,
                            controls: offered,
                            goal,
                        });
                    });
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
                        usage: SessionUsageSnapshot {
                            used,
                            size,
                            input_other: counter("inputOther"),
                            input_cache_read: counter("inputCacheRead"),
                            input_cache_creation: counter("inputCacheCreation"),
                        },
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

    match post(http, &url, &body).await {
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

/// Prompt submission is intentionally single-attempt.
///
/// KAP assigns the prompt id, so this client has no idempotency key. Retrying a POST after an
/// ambiguous transport failure could enqueue the same user action twice.
async fn submit_prompt(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
    text: &str,
    attachments: &[PromptAttachment],
    skills: &[PromptSkill],
) -> Result<String> {
    let body = prompt_body(text, attachments, skills)?;
    let url = format!("{base_url}/sessions/{session_id}/prompts");
    let data = post(http, &url, &body).await?;

    data.get("prompt_id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| KapError::Transport {
            message: format!("no prompt_id in prompt response: {data}"),
        })
}

fn prompt_body(
    text: &str,
    attachments: &[PromptAttachment],
    skills: &[PromptSkill],
) -> Result<Value> {
    let mut content = Vec::new();
    if !text.is_empty() {
        content.push(json!({ "type": "text", "text": text }));
    }
    for attachment in attachments {
        content.push(match attachment {
            PromptAttachment::Image {
                data, mime_type, ..
            } => json!({
                "type": "image",
                "source": {
                    "kind": "base64",
                    "media_type": mime_type,
                    "data": data,
                }
            }),
            PromptAttachment::Text { text, .. } => json!({
                "type": "text",
                "text": text,
            }),
        });
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

/// 三条会话出生路（新开 / 装载 / 分叉）共用的激活序列。
async fn activate(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
    from: Option<&Cursor>,
    book: &SessionBook,
    ws: &WsSink,
) -> Result<OpenedSession> {
    book.open(session_id)?;
    subscribe(ws, session_id, from).await?;

    ensure_model(http, base_url, session_id).await;

    Ok(OpenedSession {
        session_id: session_id.to_owned(),
        selectors: best_effort_selectors(http, base_url, session_id).await,
    })
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

    activate(http, base_url, &id, None, book, ws).await
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

    activate(http, base_url, session_id, from, book, ws).await
}

async fn fork_session(
    http: &reqwest::Client,
    base_url: &str,
    source_id: &str,
    drop_turns: u32,
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

    // 分叉点。:fork 的请求体只有 title 与 metadata（kap-server 的
    // sessionForkSchema），没有分叉点这一格；能回退上下文的只有 :undo，它按用户
    // 轮次数收（undoSessionRequestSchema 的 count）。回退落在复制件上，源会话
    // 一个字不动。
    if drop_turns > 0 {
        post(
            http,
            &format!("{base_url}/sessions/{id}:undo"),
            &json!({ "count": drop_turns }),
        )
        .await?;
    }

    activate(http, base_url, &id, None, book, ws).await
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
        Ok((offered, _goal)) => offered,
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

/// 队列动作：改的是「谁在等」，不是「谁在跑」。
///
/// 路由是 kap 的动作后缀（prompts:steer / prompts/{id}:abort）。队列的事实在
/// agent 那一侧，所以这里不判「还在不在排队」—— 答复只用来知道它收下了，
/// 信封仍旧只从 envelope_data 这一个闸口读。
async fn queue_action(http: &reqwest::Client, url: &str, body: &Value) -> Result<()> {
    post(http, url, body).await?;

    Ok(())
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

/// 读取目标真相；协议缺席与传输失败不能合并。
async fn fetch_goal(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
) -> Result<Option<GoalSnapshot>> {
    let goal = get(http, &format!("{base_url}/sessions/{session_id}/goal")).await?;

    Ok(goal_snapshot(&goal))
}

/// 选择器表与目标快照一趟取回：turn.ended 收尾两样都要，分开打就是同一轮里
/// 第二次 /goal。
async fn get_selectors(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
) -> Result<(Vec<ConfigControl>, Option<GoalSnapshot>)> {
    let status = get(http, &format!("{base_url}/sessions/{session_id}/status")).await?;
    let catalog = get(http, &format!("{base_url}/models")).await?;
    let goal = get(http, &format!("{base_url}/sessions/{session_id}/goal")).await?;
    Ok((controls(&status, &catalog, &goal), goal_snapshot(&goal)))
}

async fn set_selector(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
    config_id: &str,
    value: &str,
    input: Option<&str>,
) -> Result<Vec<ConfigControl>> {
    let (current, _goal) = get_selectors(http, base_url, session_id).await?;
    let control = current
        .iter()
        .find(|control| control.id == config_id)
        .ok_or_else(|| KapError::Validation {
            message: format!("the session offers no control {config_id}"),
        })?;
    if control.current == value && input.is_none() {
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
    let (selectors, _goal) = get_selectors(http, base_url, session_id).await?;
    Ok(selectors)
}

#[cfg(test)]
mod tests {
    // 与 tests/recorder.rs 顶上那一句同一条纪律、同一个理由（Cargo.toml lints
    // 注释）：测试里的 expect 是响亮失败，豁免只写在测试作用域，不靠根配置放开。
    #![allow(
        clippy::expect_used,
        reason = "a test proves itself by panicking, so a failed step must fail the test"
    )]

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

#[cfg(test)]
mod event_router_tests {
    #![allow(clippy::expect_used, reason = "a broken test fixture must fail loudly")]

    use futures::{FutureExt, StreamExt};
    use serde_json::json;

    use super::{EventRouter, InstanceDisk, SessionBook, SessionEvent};
    use crate::{PermissionDesk, QuestionDesk, SessionUsageSnapshot};

    #[test]
    fn instance_registry_filters_before_network_probing() {
        let current = r#"{"host":"0.0.0.0","port":58627,"started_at":20}"#;
        let stale = r#"{"host":"127.0.0.1","port":58628,"started_at":9}"#;

        assert!(InstanceDisk::eligible(current, 10).is_some());
        assert!(InstanceDisk::eligible(stale, 10).is_none());
        assert!(InstanceDisk::eligible("not json", 10).is_none());
    }

    #[tokio::test]
    async fn ws_router_types_usage_before_crossing_the_runtime_boundary() {
        const SESSION: &str = "session-test";
        let book = SessionBook::new();

        let (events, mut received) = futures::channel::mpsc::unbounded();
        let mut router = EventRouter::new(
            book,
            PermissionDesk::new(),
            QuestionDesk::new(),
            events,
            reqwest::Client::new(),
            "http://127.0.0.1".to_owned(),
        );

        router.handle(&json!({
            "type": "agent.status.updated",
            "seq": 7,
            "session_id": SESSION,
            "payload": {
                "type": "agent.status.updated",
                "contextTokens": 12,
                "maxContextTokens": 100,
                "usage": {
                    "total": {
                        "inputOther": 3,
                        "inputCacheRead": 4,
                        "inputCacheCreation": 5
                    }
                }
            }
        }));

        let event = received
            .next()
            .now_or_never()
            .flatten()
            .expect("usage event");
        assert!(matches!(
            event,
            SessionEvent::Usage {
                session_id,
                usage: SessionUsageSnapshot {
                    used: 12,
                    size: 100,
                    input_other: 3,
                    input_cache_read: 4,
                    input_cache_creation: 5,
                }
            } if session_id == SESSION
        ));
    }
}
