//! 桥的传输驱动器：起边车、说 NDJSON、把应答与命令配对。
//!
//! 形状与它取代的 kap 驱动器一致（一条长活连接 + 命令通道 + 事件通道），换掉的
//! 只是底下那条线：kap 是 REST + WebSocket，这里是一个子进程的两根管道。
//!
//! 分工（ADR 0052）：落账、超时、取消后的重启都归本层；桥只管把 SDK 的 typed
//! event 翻成 transcript ops，不做第二套账。

use std::collections::HashMap;
use std::time::Duration;

use futures::channel::{mpsc, oneshot};
use futures::{FutureExt, StreamExt};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::error::{AgentError, Refusal, Result};
use crate::process::program::{hide_console, resolve_sidecar};
use crate::process::stderr_probe::StderrLog;
use crate::process::supervisor::{Spawned, kill_tree};
use crate::recorder::Recorder;
use crate::run_slot::RunSlot;
use crate::session::book::SessionBook;
use crate::session::client::{AgentClient, Command as ClientCommand};
use crate::session::{
    AgentConnection, AgentSpawn, Handshake, OpenedSession, SessionEvent, SessionEvents,
};
use crate::trace::{open_trace, trace};
use crate::wire::{self, Command, Event, Frame, Outcome};

/// 等握手（边车起来并报 ready、开出第一条会话）的上限。编进二进制的运行时首次
/// 解包会慢一些。
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(60);

/// 一次应答槽：桥回了什么，或为什么没回。
type Reply = oneshot::Sender<Result<Value>>;

pub fn connect(
    spawn: AgentSpawn,
    slot: RunSlot,
    desk: &crate::interaction::desk::PermissionDesk,
    questions: &crate::interaction::desk::QuestionDesk,
) -> Result<AgentConnection> {
    let AgentSpawn {
        program,
        args,
        cwd,
        env,
        home: home_dir,
    } = spawn;

    /*
     * 审批与提问这两张桌子还挂在签名上：桥暂时不推这两类事件（omp 的审批走
     * RPC 的 extension_ui_request，接它是一件单独的活），但界面那一整套照旧
     * 存在 —— ADR 0052 的后果第 5 条：控件不删，等后端补齐。
     */
    let _ = (desk, questions);

    let resolved = resolve_sidecar(&program)?;

    let (commands_tx, commands_rx) = mpsc::unbounded::<ClientCommand>();
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
            return Err(AgentError::Refused(Refusal::Gone));
        }

        let mut command = tokio::process::Command::new(&resolved);
        command
            .args(&args)
            .current_dir(&cwd)
            .envs(env.set.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            /* 受控 home：omp 读 PI_CODING_AGENT_DIR，绝对 agent 目录。 */
            .env("PI_CODING_AGENT_DIR", &home_dir)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        for name in &env.remove {
            command.env_remove(name);
        }
        hide_console(command.as_std_mut());

        let mut child = Spawned(command.spawn().map_err(|error| AgentError::Spawn {
            message: error.to_string(),
        })?);

        let outcome = run_session(
            &mut child,
            commands_rx,
            events_tx,
            Some(ready_tx),
            book_clone,
            slot,
            &cwd,
            diagnostics,
            traced,
            cancellation,
        )
        .await;

        kill_tree(&mut child.0)
            .await
            .map_err(|error| AgentError::Transport {
                message: format!("the agent process could not be reaped: {error}"),
            })?;
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

/// 一条连接的整个生命：喂命令、读帧、把两类都派发出去。
///
/// 参数多而没打包成一个结构：这些格各有寿命（连接、进程、事件出口、账本、
/// 诊断），打包只是把同一批参数换个地方写，不会让任何一个变简单。
#[allow(
    clippy::too_many_arguments,
    reason = "the connection's parts have different lifetimes; bundling them would only move the list"
)]
async fn run_session(
    child: &mut Spawned,
    mut commands_rx: mpsc::UnboundedReceiver<ClientCommand>,
    events_tx: mpsc::UnboundedSender<SessionEvent>,
    mut ready_tx: Option<oneshot::Sender<Result<Handshake>>>,
    book: SessionBook,
    slot: RunSlot,
    cwd: &std::path::Path,
    diagnostics: StderrLog,
    traced: Option<crate::trace::TraceSink>,
    cancellation: tokio_util::sync::CancellationToken,
) -> Result<()> {
    let Some(stdin) = child.0.stdin.take() else {
        return handshake_failed(ready_tx, "the agent bridge has no stdin".to_owned());
    };
    let Some(stdout) = child.0.stdout.take() else {
        return handshake_failed(ready_tx, "the agent bridge has no stdout".to_owned());
    };

    let mut stdin = stdin;

    if let Some(stderr) = child.0.stderr.take() {
        let sink = diagnostics.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                sink.push(&line);
            }
        });
    }

    let mut lines = BufReader::new(stdout).lines();
    let mut pending: HashMap<String, Reply> = HashMap::new();
    let mut issued = 0_u64;
    let mut session_id: Option<String> = None;
    let mut ready = false;
    /* 开会话那一条请求的号与它的应答槽；应答回到 Frame::Response 那一支认领。 */
    let mut opening: Option<String> = None;
    /* 握手的总期限：边车起不来时这里兜住，而不是让界面永远等。 */
    let handshake_deadline = tokio::time::sleep(HANDSHAKE_TIMEOUT);
    tokio::pin!(handshake_deadline);

    loop {
        tokio::select! {
            () = cancellation.cancelled() => {
                let _ = stdin.shutdown().await;
                return Ok(());
            }

            () = &mut handshake_deadline, if !ready => {
                return handshake_failed(
                    ready_tx,
                    format!(
                        "the agent bridge did not open a session within {}s; stderr: {}",
                        HANDSHAKE_TIMEOUT.as_secs(),
                        diagnostics.tail()
                    ),
                );
            }

            command = commands_rx.next() => {
                let Some(command) = command else {
                    let _ = stdin.shutdown().await;
                    return Ok(());
                };

                if let ClientCommand::Shutdown(receipt) = command {
                    let _ = stdin.shutdown().await;
                    let _ = receipt.send(());
                    return Ok(());
                }

                issued += 1;
                let id = format!("c{issued}");

                /* 本机就能答的命令（读账本），不进管道。 */
                if let ClientCommand::PromptState {
                    session_id: sid,
                    prompt,
                    reply,
                } = command
                {
                    use crate::session::observe::PromptObservation;

                    let observed = book
                        .prompt_state(&sid, &prompt)
                        .map(|state| state.unwrap_or(PromptObservation::Missing));

                    if let Err(error) = &observed {
                        log::error!("could not read the prompt state: {error}");
                    }

                    let _ = reply.send(observed);
                    continue;
                }

                /* 目录编辑还没接到 omp 的配置面上：本机答不支持，不走管道。 */
                if let ClientCommand::ModelCatalog { operation, reply } = command {
                    let _ = reply.send(crate::model_catalog::execute(&operation));
                    continue;
                }

                /*
                 * 取消：命令照发，同时替这一轮上闹钟。
                 *
                 * `abort` 是协作式的，桥可能不报终帧（进程卡住、事件丢失），界面上
                 * 就会永远停在「正在取消」。到期由本机收摊，账上就此了结。这里的
                 * 应答交给调用方的是「命令发出去了」，轮终归 turn_end 事件。
                 */
                if let ClientCommand::Cancel {
                    session_id: sid,
                    reply,
                } = command
                {
                    let armed = book.ended_count(&sid).ok().flatten();
                    let closer = book.clone();

                    issued += 1;
                    let cancel_id = format!("c{issued}");
                    let line = encode(&Command::Cancel {
                        id: cancel_id,
                    })?;
                    send(&mut stdin, &line).await?;

                    tokio::spawn(async move {
                        tokio::time::sleep(crate::policy::CANCEL_GRACE).await;

                        let Some(since) = armed else {
                            return;
                        };

                        match closer.finish_turn_since(&sid, "cancelled", since) {
                            Ok(true) => log::warn!(
                                "the agent bridge took the abort of {sid} but never ended the turn; closed locally"
                            ),
                            Ok(false) => {}
                            Err(error) => log::error!("could not close an aborted turn: {error}"),
                        }
                    });

                    let _ = reply.send(Ok(()));
                    continue;
                }

                /* 这条连接上那一条会话：握手时就开好了，这里只是把号交回去。 */
                if let ClientCommand::CurrentSession { reply } = command {
                    let opened = session_id.clone().map(|session_id| OpenedSession {
                        session_id,
                        selectors: Vec::new(),
                    });

                    let _ = reply.send(opened.ok_or(AgentError::Refused(Refusal::UnknownSession)));
                    continue;
                }

                /*
                 * 提交：先落准入帧，再把话送出去。
                 *
                 * 顺序是「写账先于投递」：admission 先记账，agent 才有资格回话；
                 * 反过来会出现「agent 已经答了，账上还没有这一轮」的中间态。准入
                 * 落不下去就不投 —— 宁可这一句没发出去，不可账实不符。
                 */
                if let ClientCommand::Prompt {
                    text,
                    attachments,
                    skills,
                    idempotency,
                    frames,
                    reply,
                } = command
                {
                    let Some(held_session) = session_id.clone() else {
                        let _ = reply.send(Err(AgentError::Refused(Refusal::UnknownSession)));
                        continue;
                    };

                    let held = book.slot(&held_session).ok().flatten();

                    let Some(slot) = held else {
                        let _ = reply.send(Err(AgentError::Refused(Refusal::UnknownSession)));
                        continue;
                    };

                    if slot
                        .attach(|| Recorder::new(held_session.clone(), slot.seq(), frames))
                        .is_err()
                    {
                        let _ = reply.send(Err(AgentError::Poisoned));
                        continue;
                    }

                    let mut durable = false;
                    let attached = skills.iter().map(|skill| skill.name.clone()).collect();
                    let recorded = slot.record(|recorder| {
                        durable = recorder.record_prompt_admitted(&idempotency, &text, attached);
                    });

                    if !recorded || !durable {
                        let _ = reply.send(Err(AgentError::Transport {
                            message: "the frame journal refused the prompt admission".to_owned(),
                        }));
                        continue;
                    }

                    /* 准入过了才投。命令与上面那条支路共用 outgoing。 */
                    let line = encode(&Command::Prompt {
                        id: id.clone(),
                        text,
                        attachments: attachments
                            .into_iter()
                            .map(|attachment| match attachment {
                                crate::session::client::PromptAttachment::Image { path, .. }
                                | crate::session::client::PromptAttachment::File { path, .. } => {
                                    path.to_string_lossy().into_owned()
                                }
                            })
                            .collect(),
                        skills: skills
                            .into_iter()
                            .map(|skill| wire::PromptSkill {
                                name: skill.name,
                                args: skill.args,
                            })
                            .collect(),
                    })?;

                    let (slot_reply, answer) = oneshot::channel();
                    let _replaced = pending.insert(id.clone(), slot_reply);
                    let prompt_id = idempotency.clone();

                    /* 应答到了就把它认成这一轮的幂等键交回去（不是停止原因）。 */
                    tokio::spawn(async move {
                        let result = match answer.await {
                            Ok(Ok(_data)) => Ok(prompt_id),
                            Ok(Err(error)) => Err(error),
                            Err(_dropped) => Err(AgentError::Refused(Refusal::Gone)),
                        };

                        let _ = reply.send(result);
                    });

                    send(&mut stdin, &line).await?;
                    continue;
                }

                match outgoing(command, &id, session_id.as_deref()) {
                    Ok(Some((line, reply))) => {
                        if let Some(reply) = reply {
                            let _replaced = pending.insert(id, reply);
                        }

                        if let Err(error) = send(&mut stdin, &line).await {
                            /* 握手还没完成就是启动失败；已经开跑就是链路断了。 */
                            return handshake_failed(ready_tx, error.to_string());
                        }
                    }
                    Ok(None) => {}
                    Err(error) => {
                        /* 桥不认的命令：如实报错，不假装成功。 */
                        log::debug!("the agent bridge cannot do this: {error}");
                    }
                }
            }

            line = lines.next_line() => {
                let Some(line) = line.map_err(|error| transport(&error))? else {
                    return Err(AgentError::Transport {
                        message: "the agent bridge closed its stdout".to_owned(),
                    });
                };

                if line.len() > wire::MAX_LINE_BYTES {
                    return Err(AgentError::Transport {
                        message: format!("the agent bridge sent {} bytes on one line", line.len()),
                    });
                }

                if line.trim().is_empty() {
                    continue;
                }

                if let Some(sink) = traced.as_deref() {
                    trace(sink, "in  ", &line);
                }

                let frame = wire::decode(&line).map_err(|error| AgentError::Transport {
                    message: format!("the agent bridge sent a frame that does not fit: {error}"),
                })?;

                match frame {
                    Frame::Ready { protocol_version, .. } => {
                        if protocol_version != wire::PROTOCOL_VERSION {
                            return handshake_failed(
                                ready_tx,
                                format!(
                                    "the agent bridge speaks protocol {protocol_version}, this build speaks {}",
                                    wire::PROTOCOL_VERSION
                                ),
                            );
                        }

                        ready = true;

                        /*
                         * 开第一条会话。应答**不能**在这里 await：这一支正占着
                         * 读循环，await 就等于没人再去读 stdout，双方互等。
                         * 请求发出去，号记在 `opening` 上，等 Response 那一支认领。
                         */
                        issued += 1;
                        let id = format!("c{issued}");
                        let line = encode(&Command::NewSession {
                            id: id.clone(),
                            cwd: cwd.to_string_lossy().into_owned(),
                        })?;
                        opening = Some(id);

                        send(&mut stdin, &line).await?;
                    }

                    Frame::Response { id, data } => {
                        if let Some(reply) = pending.remove(&id) {
                            let _ = reply.send(Ok(data.clone()));
                        }

                        if opening.as_deref() == Some(id.as_str()) {
                            opening = None;

                            let opened = data
                                .get("sessionId")
                                .and_then(Value::as_str)
                                .map(str::to_owned);

                            let Some(opened) = opened else {
                                return handshake_failed(
                                    ready_tx,
                                    "the agent bridge opened a session without an id".to_owned(),
                                );
                            };

                            if book.adopt(&opened, slot.clone()).is_err() {
                                if let Some(tx) = ready_tx.take() {
                                    let _ = tx.send(Err(AgentError::Poisoned));
                                }
                                return Err(AgentError::Poisoned);
                            }

                            session_id = Some(opened.clone());

                            if let Some(tx) = ready_tx.take() {
                                let _ = tx.send(Ok(Handshake { session_id: opened }));
                            }
                        }
                    }

                    Frame::Failed { id, message } => {
                        if let Some(reply) = pending.remove(&id) {
                            let _ = reply.send(Err(AgentError::Envelope { code: 0, message }));
                        } else {
                            log::warn!("the agent bridge reported a failure for an unknown command: {message}");
                        }
                    }

                    Frame::Event { event } => {
                        if ready {
                            dispatch(event, &events_tx, &book, &diagnostics);
                        }
                    }
                }
            }
        }
    }
}

fn transport(error: &std::io::Error) -> AgentError {
    AgentError::Transport {
        message: error.to_string(),
    }
}

/// 握手期的一处失败：既是给调用方的错误，也是给等 Handshake 的那个槽的答复。
///
/// AgentError 不是 Clone（它带着 io::Error 与外来的 code），所以这里按消息重造一份，
/// 而不是把同一个值送两处。
fn handshake_failed(
    mut ready_tx: Option<oneshot::Sender<Result<Handshake>>>,
    message: String,
) -> Result<()> {
    if let Some(tx) = ready_tx.take() {
        let _ = tx.send(Err(AgentError::Handshake {
            message: message.clone(),
        }));
    }

    Err(AgentError::Handshake { message })
}

fn encode(command: &Command) -> Result<String> {
    wire::encode(command).map_err(|error| AgentError::Transport {
        message: error.to_string(),
    })
}

async fn send(stdin: &mut tokio::process::ChildStdin, line: &str) -> Result<()> {
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|error| transport(&error))?;
    stdin.flush().await.map_err(|error| transport(&error))
}

/// 一条命令要等应答时，把它交回给调用方的槽：应答到了就按各自的形状解出来。
///
/// 每条命令一个 `shape`：桥回的是通用 JSON，而调用方要的是各自的类型，转换只在
/// 这里做一次。
type Wire = Option<(String, Option<Reply>)>;

/// 把一条线上命令配上一个应答槽；回包按 `shape` 解出来交给调用方。
fn ask<T, F>(command: &Command, reply: oneshot::Sender<Result<T>>, shape: F) -> Result<Wire>
where
    T: Send + 'static,
    F: FnOnce(Value) -> Result<T> + Send + 'static,
{
    let (slot, answer) = oneshot::channel::<Result<Value>>();

    tokio::spawn(async move {
        let result = answer
            .await
            .map_err(|_dropped| AgentError::Refused(Refusal::Gone))
            .and_then(|outcome| outcome.and_then(shape));
        let _ = reply.send(result);
    });

    Ok(Some((encode(command)?, Some(slot))))
}

fn outgoing(command: ClientCommand, id: &str, session_id: Option<&str>) -> Result<Wire> {
    let named = || -> Result<String> {
        session_id
            .map(str::to_owned)
            .ok_or(AgentError::Refused(Refusal::UnknownSession))
    };

    match command {
        ClientCommand::Steer { prompt_ids, reply } => {
            let _session = named()?;

            ask(
                &Command::Steer {
                    id: id.to_owned(),
                    text: prompt_ids.join("\n"),
                },
                reply,
                |_| Ok(()),
            )
        }

        ClientCommand::Selectors { reply } => {
            ask(&Command::Selectors { id: id.to_owned() }, reply, |data| {
                Ok(controls_of(&data))
            })
        }

        ClientCommand::Select {
            config_id,
            value,
            reply,
        } => ask(
            &Command::Select {
                id: id.to_owned(),
                config_id,
                value,
            },
            reply,
            |data| Ok(controls_of(&data)),
        ),

        ClientCommand::Skills { reply } => {
            ask(&Command::Skills { id: id.to_owned() }, reply, |data| {
                Ok(skills_of(&data))
            })
        }

        ClientCommand::McpServers { reply } => {
            ask(&Command::McpServers { id: id.to_owned() }, reply, |data| {
                Ok(servers_of(&data))
            })
        }

        /* 这些在驱动器的别的支上收掉了，或者本机自己答；到不了这里。 */
        ClientCommand::Prompt { .. }
        | ClientCommand::CurrentSession { .. }
        | ClientCommand::Cancel { .. }
        | ClientCommand::Shutdown(_)
        | ClientCommand::PromptState { .. }
        | ClientCommand::ModelCatalog { .. } => Ok(None),
    }
}

fn controls_of(data: &Value) -> Vec<crate::ConfigControl> {
    data.get("controls")
        .and_then(Value::as_array)
        .map(|controls| controls.iter().filter_map(control_of).collect())
        .unwrap_or_default()
}

fn skills_of(_data: &Value) -> Vec<crate::Skill> {
    Vec::new()
}

fn servers_of(_data: &Value) -> Vec<crate::McpServer> {
    Vec::new()
}

/// 桥报的一条选择器 → 产品控制项。
fn control_of(value: &Value) -> Option<crate::ConfigControl> {
    use crate::session::config::{ConfigChoice, ConfigPurpose};

    let id = value.get("id")?.as_str()?.to_owned();
    let purpose = match value.get("purpose").and_then(Value::as_str) {
        Some("model") => ConfigPurpose::Model,
        Some("thinking") => ConfigPurpose::Thought,
        Some("mode") => ConfigPurpose::Mode,
        _ => ConfigPurpose::Other,
    };

    let choices = value
        .get("choices")
        .and_then(Value::as_array)
        .map(|choices| {
            choices
                .iter()
                .filter_map(|choice| {
                    Some(ConfigChoice {
                        value: choice.get("value")?.as_str()?.to_owned(),
                        label: choice
                            .get("label")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        detail: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Some(crate::ConfigControl {
        label: id.clone(),
        detail: None,
        applies_on_submit: false,
        id,
        purpose,
        current: value
            .get("current")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        choices,
    })
}

/// 桥推上来的一条事件 → 宿主能认的会话事件。
fn dispatch(
    event: Event,
    events_tx: &mpsc::UnboundedSender<SessionEvent>,
    book: &SessionBook,
    diagnostics: &StderrLog,
) {
    match event {
        Event::Transcript {
            session_id,
            payload,
        } => {
            let _sent = events_tx.unbounded_send(SessionEvent::Transcript {
                session_id,
                payload,
            });
        }

        Event::TurnEnd {
            session_id,
            outcome,
            message,
        } => {
            let closed = match outcome {
                Outcome::Failed => {
                    book.fail_turn(&session_id, message.as_deref().unwrap_or("the turn failed"))
                }
                other => book.finish_turn(&session_id, other.stop_reason()),
            };

            if let Err(error) = closed {
                log::error!("could not close the turn the bridge ended: {error}");
            }

            if outcome == Outcome::Failed {
                log::warn!(
                    "the agent bridge failed a turn: {}; stderr: {}",
                    message.as_deref().unwrap_or("no message"),
                    diagnostics.tail()
                );
            }
        }

        Event::Selectors {
            session_id,
            controls,
        } => {
            let _sent = events_tx.unbounded_send(SessionEvent::Selectors {
                session_id,
                controls: controls.iter().filter_map(control_of).collect(),
                goal: None,
            });
        }

        Event::Usage { session_id, usage } => {
            let counter = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);

            let _sent = events_tx.unbounded_send(SessionEvent::Usage {
                session_id,
                usage: crate::SessionUsageSnapshot {
                    used: counter("used"),
                    size: counter("size"),
                    input_other: counter("inputOther"),
                    input_cache_read: counter("inputCacheRead"),
                    input_cache_creation: counter("inputCacheCreation"),
                },
            });
        }
    }
}
