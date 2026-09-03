//! kap 传输驱动器：起进程、开锚会话、握手、主循环收命令收事件。
//!
//! 进程模型：spawn "kimi web --no-open" → 等注册表出现本次拉起后的条目、且那个
//! 地址认我们手里的 server.token（process/instance_registry）→ REST 开锚会话
//! （rest.rs）→ WS client_hello + subscribe（connection/）→ 主循环收命令、收事件。
//!
//! 事件帧的 type 就是事件自己的 type（turn.ended / assistant.delta / …）：
//! 信封是 { type, seq, session_id, timestamp, payload }，payload 里再带一份
//! 同名 type、agentId 与 sessionId。没有哪一帧的 type 是 "session_event"：
//! wire 上事件帧的 type 字段就是事件自己的类型名（契约快照钉在
//! contracts/kap/asyncapi.json）。
//!
//! 数据流：
//!   命令 → Command 枚举（client.rs）→ REST（rest.rs）或 WS 控制帧（connection/）
//!   事件 → WS 事件帧 → router.rs → RecordedEvent → Tauri
//!
//! 协议事实来源是 MoonshotAI/kimi-code 的 packages/kap-server（routes/ 与
//! protocol/ 两个目录），快照钉在 contracts/kap。信封约定
//! { code, msg, data, request_id }：业务成败看 code，不看 HTTP 状态。

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use futures::channel::{mpsc, oneshot};
use futures::{FutureExt, SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;

use crate::connection::handshake::{shake_hands, subscribe, wait_subscribe_ack};
use crate::connection::reconnect::{fail_in_flight, relink};
use crate::connection::socket::{WsSink, dial_ws, send_frame};
use crate::error::{KapError, Refusal, Result};
use crate::generated::events::{ClientFrame, PongStruct, ServerFrame, websocket};
use crate::generated::rest::{SteerPromptsRequestStruct, routes};
use crate::interaction::desk::{PermissionDesk, QuestionDesk};
use crate::model_catalog::execute as execute_model_catalog;
use crate::process::instance_registry::{dialable_host, discover_instance};
use crate::process::program::{hide_console, resolve_program};
use crate::process::stderr_probe::StderrLog;
use crate::process::supervisor::{Spawned, kill_tree};
use crate::recorder::{Recorder, now_millis};
use crate::run_slot::RunSlot;
use crate::server_frame;
use crate::session::book::SessionBook;
use crate::session::client::{AgentClient, Command};
use crate::session::export::export_session;
use crate::session::rest::{
    abort_session, archive_session, create_session_body, fetch_goal, fork_session,
    get_selectors, install_capability, list_capabilities, list_mcp_servers, list_sessions,
    list_skills, load_session, open_session, post, set_selector, submit_prompt,
};
use crate::session::router::EventRouter;
use crate::session::{AgentConnection, AgentSpawn, Handshake, SessionEvent, SessionEvents};
use crate::trace::{open_trace, trace};

/// 取消被 kap 收下之后，等 turn.ended 的宽限期。
///
/// kap 的 :abort 是协作式的，不保证终帧一定回来（client.rs 的
/// AgentClient::cancel）。屏幕上那条经过由帧日志出，没有终帧就没有终态 ——
/// 所以到期由本机把这一轮收摊，而不是让它永远停在"正在取消"。
const CANCEL_GRACE: Duration = Duration::from_secs(10);

/// 命令处理的统一收尾：spawn 出去的工作无论成败，收据必回命令端。
async fn settle<T>(reply: oneshot::Sender<Result<T>>, fut: impl Future<Output = Result<T>>) {
    let _ = reply.send(fut.await);
}

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
            .envs(env.set.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped());
        for name in &env.remove {
            command.env_remove(name);
        }
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
        let base_url = format!("http://{dial}:{port}");

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
            routes::create_session(&base_url),
            &create_session_body(&cwd),
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

        let Some(session_id) = session
            .get("id")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
        else {
            let handshake = KapError::Handshake {
                message: format!("no session id in POST /sessions response: {session}"),
            };
            let _ = ready_tx.send(Err(KapError::Handshake {
                message: handshake.to_string(),
            }));
            return Err(handshake);
        };

        // 6. WebSocket 握手。首连与重连走同一个 dial_ws / shake_hands。
        let ws_url = websocket::connect(&base_url).map_err(|error| KapError::Transport {
            message: error.to_string(),
        })?;

        let ws_stream = match dial_ws(ws_url.as_str(), &auth_header).await {
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
        let mut stash: Vec<serde_json::Value> = Vec::new();

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
            base_url.clone(), Arc::clone(&ws));

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
                    ws_url.as_str(),
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

                            tokio::spawn(settle(reply, async move {
                                post(
                                    &http,
                                    routes::steer_prompts(&base, &sid),
                                    &SteerPromptsRequestStruct { prompt_ids },
                                )
                                .await
                                .map(|_| ())
                            }));
                        }

                        Some(Command::AbortPrompt {
                            session_id: sid,
                            prompt_id,
                            reply,
                        }) => {
                            let http = http.clone();
                            let base = base_url.clone();

                            tokio::spawn(settle(reply, async move {
                                post(
                                    &http,
                                    routes::abort_prompt(&base, &sid, &format!("{prompt_id}:abort")),
                                    &serde_json::json!({}),
                                )
                                .await
                                .map(|_| ())
                            }));
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
                            let http = http.clone();
                            let base = base_url.clone();
                            let book = book_clone.clone();
                            let ws = Arc::clone(&ws);
                            tokio::spawn(settle(reply, async move {
                                open_session(&http, &base, &new_cwd, &book, &ws).await
                            }));
                        }

                        Some(Command::LoadSession { session_id: sid, from, reply }) => {
                            let http = http.clone();
                            let base = base_url.clone();
                            let book = book_clone.clone();
                            let ws = Arc::clone(&ws);
                            tokio::spawn(settle(reply, async move {
                                load_session(&http, &base, &sid, from.as_ref(), &book, &ws).await
                            }));
                        }

                        Some(Command::ForkSession { session_id: src, drop_turns, reply }) => {
                            let http = http.clone();
                            let base = base_url.clone();
                            let book = book_clone.clone();
                            let ws = Arc::clone(&ws);
                            tokio::spawn(settle(reply, async move {
                                fork_session(&http, &base, &src, drop_turns, &book, &ws).await
                            }));
                        }

                        Some(Command::DeleteSession { session_id: sid, reply }) => {
                            // kap 没有硬删除，删除由 :archive 承接；本地索引同步移除。
                            let http = http.clone();
                            let base = base_url.clone();
                            let book = book_clone.clone();
                            tokio::spawn(settle(reply, async move {
                                archive_session(&http, &base, &sid, &book).await
                            }));
                        }

                        Some(Command::Sessions { reply }) => {
                            let http = http.clone();
                            let base = base_url.clone();
                            tokio::spawn(settle(reply, async move {
                                list_sessions(&http, &base).await
                            }));
                        }

                        Some(Command::Prompt { session_id: sid, text, attachments, skills, idempotency, frames, reply }) => {
                            let held = book_clone.slot(&sid).ok().flatten();
                            if let Some(slot) = held {
                                let admission_id = idempotency.clone();
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
                                let http = http.clone();
                                let base = base_url.clone();
                                tokio::spawn(settle(reply, async move {
                                    submit_prompt(
                                        &http,
                                        &base,
                                        &sid,
                                        &text,
                                        &attachments,
                                        &skills,
                                        &idempotency,
                                    )
                                    .await
                                }));
                            } else {
                                let _sent = reply.send(Err(KapError::Refused(Refusal::UnknownSession)));
                            }
                        }

                        Some(Command::ExportSession { session_id: sid, destination, reply }) => {
                            let http = http.clone();
                            let base = base_url.clone();
                            tokio::spawn(settle(reply, async move {
                                export_session(&http, &base, &sid, &destination).await
                            }));
                        }

                        Some(Command::Skills { session_id: sid, reply }) => {
                            let http = http.clone();
                            let base = base_url.clone();
                            tokio::spawn(settle(reply, async move {
                                list_skills(&http, &base, &sid).await
                            }));
                        }

                        Some(Command::McpServers { reply }) => {
                            let http = http.clone();
                            let base = base_url.clone();
                            tokio::spawn(settle(reply, async move {
                                list_mcp_servers(&http, &base).await
                            }));
                        }

                        Some(Command::Capabilities { reply }) => {
                            let http = http.clone();
                            let base = base_url.clone();
                            tokio::spawn(settle(reply, async move {
                                list_capabilities(&http, &base).await
                            }));
                        }

                        Some(Command::InstallCapability { capability_id, reply }) => {
                            let http = http.clone();
                            let base = base_url.clone();
                            tokio::spawn(settle(reply, async move {
                                install_capability(&http, &base, &capability_id).await
                            }));
                        }

                        Some(Command::ModelCatalog { operation, reply }) => {
                            let http = http.clone();
                            let base = base_url.clone();
                            tokio::spawn(settle(reply, async move {
                                execute_model_catalog(&http, &base, operation).await
                            }));
                        }

                        Some(Command::Selectors { session_id: sid, reply }) => {
                            let http = http.clone();
                            let base = base_url.clone();
                            tokio::spawn(settle(reply, async move {
                                get_selectors(&http, &base, &sid)
                                    .await
                                    .map(|(offered, _goal)| offered)
                            }));
                        }

                        Some(Command::Goal { session_id: sid, reply }) => {
                            let http = http.clone();
                            let base = base_url.clone();
                            tokio::spawn(settle(reply, async move {
                                fetch_goal(&http, &base, &sid).await
                            }));
                        }

                        Some(Command::Select { session_id: sid, config_id, value, input, reply }) => {
                            let http = http.clone();
                            let base = base_url.clone();
                            tokio::spawn(settle(reply, async move {
                                set_selector(&http, &base, &sid, &config_id, &value, input.as_deref())
                                    .await
                            }));
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
                            // kap 的心跳是应用层帧（契约快照 contracts/kap/
                            // asyncapi.json 的 ping/pong），与 tungstenite 的协议层
                            // Ping 是两回事 —— 两个都要答。
                            if let Ok(ServerFrame::Ping { payload, .. }) =
                                server_frame(&raw)
                            {
                                send_frame(
                                    &ws,
                                    ClientFrame::Pong {
                                        payload: PongStruct {
                                            nonce: payload.nonce,
                                        },
                                    },
                                )
                                .await
                                .ok();
                            } else if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                                router.handle(&v);
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
