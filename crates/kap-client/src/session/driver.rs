//! kap 传输驱动器。事件信封 { type, seq, session_id, timestamp, payload }；REST 信封成败看 code（契约快照 contracts/kap/asyncapi.json）。

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use futures::channel::{mpsc, oneshot};
use futures::{FutureExt, SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;

use crate::compatibility::require_pinned_capabilities;
use crate::connection::handshake::{
    shake_hands, subscribe, subscribe_transcript, wait_subscribe_ack,
};
use crate::connection::socket::{WsSink, dial_ws, send_frame};
use crate::error::{KapError, Refusal, Result};
use crate::generated::events::{ClientFrame, PongStruct, ServerFrame, websocket};
use crate::generated::rest::{SteerPromptsRequestStruct, routes};
use crate::http::post;
use crate::interaction::desk::{PermissionDesk, QuestionDesk};
use crate::model_catalog::execute as execute_model_catalog;
use crate::policy::CANCEL_GRACE;
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
use crate::session::reconnect::{fail_in_flight, relink};
use crate::session::rest::{
    archive_session, catch_up_transcript, create_session_body, ensure_session_model, fetch_goal,
    fork_session, get_selectors, install_capability, list_capabilities, list_mcp_servers,
    list_sessions, list_skills, load_session, open_session, read_transcript, set_selector,
    submit_prompt,
};
use crate::session::router::EventRouter;
use crate::session::{AgentConnection, AgentSpawn, Handshake, SessionEvent, SessionEvents};
use crate::trace::{open_trace, trace};

async fn settle<T>(reply: oneshot::Sender<Result<T>>, fut: impl Future<Output = Result<T>>) {
    let _ = reply.send(fut.await);
}

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

    let stop = tokio_util::sync::CancellationToken::new();
    let cancellation = stop.clone();
    let driver = async move {
        let _connection_lifetime = cancellation.clone().drop_guard();
        if cancellation.is_cancelled() {
            return Err(KapError::Refused(Refusal::Gone));
        }
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

        let tasks = super::tasks::SessionTasks::new(cancellation.clone());
        let mut shutdown_reply = None;
        let operation = async {
        let diag_stderr = diagnostics.clone();
        if let Some(stderr) = child.0.stderr.take() {
            tasks.spawn(async move {
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
                let message = format!("{error}; server stderr: {}", diagnostics.tail());

                let _ = ready_tx.send(Err(KapError::Handshake {
                    message: message.clone(),
                }));

                return Err(KapError::Handshake { message });
            }
        };

        let dial = dialable_host(&host);
        let base_url = format!("http://{dial}:{port}");

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

        if let Err(error) = require_pinned_capabilities(&http, &base_url).await {
            let _ = ready_tx.send(Err(KapError::Handshake {
                message: error.to_string(),
            }));
            return Err(error);
        }

        // create handler 不消费 agent_config；模型随后经 profile 绑定。
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

        if let Err(error) = ensure_session_model(&http, &base_url, &session_id).await {
            let _ = ready_tx.send(Err(KapError::Handshake {
                message: error.to_string(),
            }));
            return Err(error);
        }

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

        let mut stash: Vec<serde_json::Value> = Vec::new();

        if let Err(error) = shake_hands(&ws, &mut ws_rx, &mut stash).await {
            let _ = ready_tx.send(Err(KapError::Handshake {
                message: error.to_string(),
            }));
            return Err(error);
        }

        if book_clone.adopt(&session_id, slot).is_err() {
            let _ = ready_tx.send(Err(KapError::Poisoned));
            return Err(KapError::Poisoned);
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

        if let Err(error) = subscribe_transcript(&ws, &session_id, None).await {
            let _ = ready_tx.send(Err(KapError::Handshake {
                message: error.to_string(),
            }));

            return Err(error);
        }

        let _ = ready_tx.send(Ok(Handshake {
            session_id: session_id.clone(),
        }));

        let mut router = EventRouter::new(
            book_clone.clone(),
            desk.clone(),
            questions.clone(),
            events_tx.clone(),
            http.clone(),
            base_url.clone(), Arc::clone(&ws), tasks.clone());

        // stash 里的 ping 不必答：client_hello 与 subscribe 已刷新服务端 lastInboundAt（wsConnectionV1.ts onHeartbeat）。
        for envelope in std::mem::take(&mut stash) {
            router.handle(&envelope);
        }

        let mut commands_rx = commands_rx;
        let mut severed: Option<String> = None;

        loop {
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
                            shutdown_reply = Some(gone);
                            break;
                        }
                        None => break,

                        Some(Command::Steer {
                            session_id: sid,
                            prompt_ids,
                            reply,
                        }) => {
                            let http = http.clone();
                            let base = base_url.clone();

                            tasks.spawn(settle(reply, async move {
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

                            tasks.spawn(settle(reply, async move {
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
                            let http = http.clone();
                            let base = base_url.clone();
                            let book2 = book_clone.clone();
                            let aborted = book2.ended_count(&sid).ok().flatten();
                            tasks.spawn(async move {
                                let result = post(
                                    &http,
                                    routes::abort_session(&base, &format!("{sid}:abort")),
                                    &serde_json::json!({}),
                                )
                                .await
                                .map(|_| ());
                                let accepted = result.is_ok();
                                let _ = reply.send(result);

                                /* abort 未被 kap 接受时这一轮还在 agent 手上，轮终仍由 turn.ended 说话。 */
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
                            tasks.spawn(settle(reply, async move {
                                open_session(&http, &base, &new_cwd, &book, &ws).await
                            }));
                        }

                        Some(Command::LoadSession { session_id: sid, from, reply }) => {
                            let http = http.clone();
                            let base = base_url.clone();
                            let book = book_clone.clone();
                            let ws = Arc::clone(&ws);
                            tasks.spawn(settle(reply, async move {
                                load_session(&http, &base, &sid, from.as_ref(), &book, &ws).await
                            }));
                        }

                        Some(Command::ForkSession { session_id: src, drop_turns, reply }) => {
                            let http = http.clone();
                            let base = base_url.clone();
                            let book = book_clone.clone();
                            let ws = Arc::clone(&ws);
                            tasks.spawn(settle(reply, async move {
                                fork_session(&http, &base, &src, drop_turns, &book, &ws).await
                            }));
                        }

                        Some(Command::DeleteSession { session_id: sid, reply }) => {
                            // kap 没有硬删除，删除由 :archive 承接；本地索引同步移除。
                            let http = http.clone();
                            let base = base_url.clone();
                            let book = book_clone.clone();
                            let ws = Arc::clone(&ws);
                            tasks.spawn(settle(reply, async move {
                                archive_session(&http, &base, &sid, &book, &ws).await
                            }));
                        }

                        Some(Command::Sessions { reply }) => {
                            let http = http.clone();
                            let base = base_url.clone();
                            tasks.spawn(settle(reply, async move {
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
                                tasks.spawn(settle(reply, async move {
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
                            tasks.spawn(settle(reply, async move {
                                export_session(&http, &base, &sid, &destination).await
                            }));
                        }

                        Some(Command::Skills { session_id: sid, reply }) => {
                            let http = http.clone();
                            let base = base_url.clone();
                            tasks.spawn(settle(reply, async move {
                                list_skills(&http, &base, &sid).await
                            }));
                        }

                        Some(Command::McpServers { reply }) => {
                            let http = http.clone();
                            let base = base_url.clone();
                            tasks.spawn(settle(reply, async move {
                                list_mcp_servers(&http, &base).await
                            }));
                        }

                        Some(Command::Capabilities { reply }) => {
                            let http = http.clone();
                            let base = base_url.clone();
                            tasks.spawn(settle(reply, async move {
                                list_capabilities(&http, &base).await
                            }));
                        }

                        Some(Command::InstallCapability { capability_id, reply }) => {
                            let http = http.clone();
                            let base = base_url.clone();
                            tasks.spawn(settle(reply, async move {
                                install_capability(&http, &base, &capability_id).await
                            }));
                        }

                        Some(Command::ModelCatalog { operation, reply }) => {
                            let http = http.clone();
                            let base = base_url.clone();
                            tasks.spawn(settle(reply, async move {
                                execute_model_catalog(&http, &base, operation).await
                            }));
                        }

                        Some(Command::Selectors { session_id: sid, reply }) => {
                            let http = http.clone();
                            let base = base_url.clone();
                            tasks.spawn(settle(reply, async move {
                                get_selectors(&http, &base, &sid)
                                    .await
                                    .map(|(offered, _goal)| offered)
                            }));
                        }

                        Some(Command::Goal { session_id: sid, reply }) => {
                            let http = http.clone();
                            let base = base_url.clone();
                            tasks.spawn(settle(reply, async move {
                                fetch_goal(&http, &base, &sid).await
                            }));
                        }

                        Some(Command::ReadTranscript { session_id: sid, agent_id, before_turn, reply }) => {
                            let http = http.clone();
                            let base = base_url.clone();
                            tasks.spawn(settle(reply, async move {
                                read_transcript(&http, &base, &sid, &agent_id, before_turn.as_deref())
                                    .await
                            }));
                        }

                        Some(Command::CatchUpTranscript { session_id: sid, agent_id, since_seq, reply }) => {
                            let http = http.clone();
                            let base = base_url.clone();
                            tasks.spawn(settle(reply, async move {
                                catch_up_transcript(&http, &base, &sid, &agent_id, since_seq).await
                            }));
                        }

                        Some(Command::Select { session_id: sid, config_id, value, input, reply }) => {
                            let http = http.clone();
                            let base = base_url.clone();
                            tasks.spawn(settle(reply, async move {
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
                            // kap 心跳是应用层帧（contracts/kap/asyncapi.json 的 ping/pong），与 tungstenite 协议层 Ping 都要答。
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
        Ok(())
        };
        let outcome = tokio::select! {
            result = operation => result,
            () = cancellation.cancelled() => Err(KapError::Refused(Refusal::Gone)),
        };
        let stopped = kill_tree(&mut child.0).await;
        tasks.shutdown().await;
        desk.clear();
        questions.clear();
        stopped.map_err(|error| KapError::Transport {
            message: format!("the agent process could not be reaped: {error}"),
        })?;
        if let Some(reply) = shutdown_reply {
            let _sent = reply.send(());
        }
        outcome
    }
    .boxed();

    Ok(AgentConnection {
        stop,
        book,
        client: AgentClient::new(commands_tx),
        handshake: ready_rx,
        events: SessionEvents::new(events_rx),
        driver,
    })
}
