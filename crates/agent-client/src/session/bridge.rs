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

/// 一个字符串数组字段；缺席或形状不对就是 None，不猜成空表。
///
/// 「没有这一格」与「这一格是空表」在下游不是一回事：界面按它判这条模型支不支持
/// 思考、有哪些档位，回空表等于说「一个档位都没有」。
fn strings(value: &Value, key: &str) -> Option<Vec<String>> {
    value.get(key).and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    })
}

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
     * 审批桌要交给驱动器：桥报上来的 permission_requested 落在这里等人答，
     * 人的答复再从 answer_permission 那条命令回到桥上。提问桌还没有对应的
     * 事件源（omp 的 ask 工具走 askDialog，尚未接），照旧留着。
     */
    let desk = desk.clone();
    let _ = questions;

    let resolved = resolve_sidecar(&program)?;

    let (commands_tx, commands_rx) = mpsc::unbounded::<ClientCommand>();
    let (events_tx, events_rx) = mpsc::unbounded::<SessionEvent>();
    let (ready_tx, ready_rx) = oneshot::channel::<Result<Handshake>>();

    /* 驱动器自己也要发命令（把授权答复送回桥），所以留一个自己的句柄。 */
    let outbound = AgentClient::new(commands_tx.clone());

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
            desk,
            outbound,
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
    desk: crate::interaction::desk::PermissionDesk,
    outbound: AgentClient,
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
    /* 重装会话请求的号，同在 Response 那一支认领。 */
    let mut switching: Option<String> = None;
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

                /*
                 * 模型目录：走管道问桥（它拿着 agent 自己的注册表与配置）。
                 * 本层只把产品的那份 operation 转成线上的形状。
                 */
                if let ClientCommand::ModelCatalog { operation, reply } = command {
                    let (slot, answer) = oneshot::channel();
                    let line = encode(&Command::ModelCatalog {
                        id: id.clone(),
                        operation: catalog_operation(&operation),
                    })?;
                    let _replaced = pending.insert(id, slot);

                    tokio::spawn(async move {
                        let result = answer
                            .await
                            .map_err(|_dropped| AgentError::Refused(Refusal::Gone))
                            .and_then(|outcome| outcome.map(|data| catalog_snapshot(&data)));
                        let _ = reply.send(result);
                    });

                    if let Err(error) = send(&mut stdin, &line).await {
                        return handshake_failed(ready_tx, error.to_string());
                    }

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

                /*
                 * 重装一条旧会话：应答的号由 Response 那一支的 `switching` 认领
                 * （在这里 await 就等于没人再读 stdout）。
                 */
                if let ClientCommand::LoadSession {
                    session_id: wanted,
                    cwd,
                    reply,
                } = command
                {
                    let line = encode(&Command::LoadSession {
                        id: id.clone(),
                        session_id: wanted,
                        cwd: cwd.to_string_lossy().into_owned(),
                    })?;
                    let (slot_reply, answer) = oneshot::channel();
                    let _replaced = pending.insert(id.clone(), slot_reply);
                    switching = Some(id);

                    tokio::spawn(async move {
                        let result = match answer.await {
                            Ok(Ok(data)) => match data.get("sessionId").and_then(Value::as_str) {
                                Some(opened) => Ok(OpenedSession {
                                    session_id: opened.to_owned(),
                                    selectors: controls_of(&data),
                                }),
                                /* 会话文件已经不在了：如实说没有，不是链路错误。 */
                                None => Err(AgentError::Refused(Refusal::UnknownSession)),
                            },
                            Ok(Err(error)) => Err(error),
                            Err(_dropped) => Err(AgentError::Refused(Refusal::Gone)),
                        };

                        let _ = reply.send(result);
                    });

                    send(&mut stdin, &line).await?;
                    continue;
                }

                /*
                 * 这条连接上那一条会话：握手时就开好了。号与**此刻的选择器表**一起
                 * 交回去。
                 *
                 * 表必须在这里给：上层拿它当「这条会话此刻提供什么」的第一帧，而
                 * 空表是一个有意义的答复（这家 agent 什么都不给改）。用空表表示
                 * 「还没问」的话，上层就不会再去问，屏幕上那一排控件整个消失 ——
                 * 进入具体对话后批准方式不见了，正是这一条。
                 */
                if let ClientCommand::CurrentSession { reply } = command {
                    let Some(session_id) = session_id.clone() else {
                        let _ = reply.send(Err(AgentError::Refused(Refusal::UnknownSession)));
                        continue;
                    };

                    issued += 1;
                    let ask_id = format!("c{issued}");
                    let (slot, answer) = oneshot::channel();
                    let line = encode(&Command::Selectors { id: ask_id.clone() })?;
                    let _replaced = pending.insert(ask_id, slot);
                    send(&mut stdin, &line).await?;

                    tokio::spawn(async move {
                        let result = match answer.await {
                            Ok(Ok(data)) => Ok(OpenedSession {
                                session_id,
                                selectors: controls_of(&data),
                            }),
                            Ok(Err(error)) => Err(error),
                            Err(_dropped) => Err(AgentError::Refused(Refusal::Gone)),
                        };

                        let _ = reply.send(result);
                    });

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
                        prompt_id: idempotency.clone(),
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

                        /* 重装会话的应答：认进 book 并顶掉握手那条；null（文件没了）
                         * 不动连接，UnknownSession 已由应答槽交回。 */
                        if switching.as_deref() == Some(id.as_str()) {
                            switching = None;

                            if let Some(opened) =
                                data.get("sessionId").and_then(Value::as_str).map(str::to_owned)
                            {
                                if book.adopt(&opened, slot.clone()).is_err() {
                                    return Err(AgentError::Poisoned);
                                }

                                session_id = Some(opened);
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
                            dispatch(event, &events_tx, &book, &desk, &outbound, &diagnostics);
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

        ClientCommand::AnswerPermission {
            request_id,
            decision,
            scope,
            reply,
        } => ask(
            &Command::AnswerPermission {
                id: id.to_owned(),
                request_id,
                decision,
                scope,
            },
            reply,
            |_| Ok(()),
        ),

        ClientCommand::AnswerDialog {
            request_id,
            response,
            reply,
        } => ask(
            &Command::AnswerDialog {
                id: id.to_owned(),
                request_id,
                response,
            },
            reply,
            |_| Ok(()),
        ),

        ClientCommand::Selectors { reply } => {
            ask(&Command::Selectors { id: id.to_owned() }, reply, |data| {
                Ok(controls_of(&data))
            })
        }

        ClientCommand::Goal { reply } => ask(&Command::Goal { id: id.to_owned() }, reply, |data| {
            Ok(data.get("goal").and_then(goal_of))
        }),

        ClientCommand::ReadTranscript {
            session_id,
            agent_id,
            before_turn,
            reply,
        } => ask(
            &Command::Transcript {
                id: id.to_owned(),
                session_id,
                agent_id,
                before_turn,
            },
            reply,
            Ok,
        ),

        ClientCommand::CatchUpTranscript {
            session_id,
            agent_id,
            since_seq,
            reply,
        } => ask(
            &Command::TranscriptOps {
                id: id.to_owned(),
                session_id,
                agent_id,
                since_seq,
            },
            reply,
            Ok,
        ),

        ClientCommand::Select {
            config_id,
            value,
            input,
            reply,
        } => ask(
            &Command::Select {
                id: id.to_owned(),
                config_id,
                value,
                input,
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
        | ClientCommand::ModelCatalog { .. }
        | ClientCommand::LoadSession { .. } => Ok(None),
    }
}

/// 桥报的目标 → 产品的形状。
///
/// 字段与 packages/agent-bridge/src/protocol.ts 的 GoalSnapshot 逐字对应；缺一格
/// 就报缺，不猜默认值（猜出来的 0 与真的 0 在屏幕上分不出来）。
fn goal_of(value: &Value) -> Option<crate::session::config::GoalSnapshot> {
    Some(crate::session::config::GoalSnapshot {
        objective: value.get("objective")?.as_str()?.to_owned(),
        completion_criterion: value
            .get("completionCriterion")
            .and_then(Value::as_str)
            .map(str::to_owned),
        status: value
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        turns_used: value.get("turnsUsed").and_then(Value::as_u64).unwrap_or(0),
        tokens_used: value.get("tokensUsed").and_then(Value::as_u64).unwrap_or(0),
        wall_clock_ms: value
            .get("wallClockMs")
            .and_then(Value::as_u64)
            .unwrap_or(0),
    })
}

fn controls_of(data: &Value) -> Vec<crate::ConfigControl> {
    data.get("controls")
        .and_then(Value::as_array)
        .map(|controls| controls.iter().filter_map(control_of).collect())
        .unwrap_or_default()
}

fn skills_of(data: &Value) -> Vec<crate::Skill> {
    data.get("skills")
        .and_then(Value::as_array)
        .map(|skills| {
            skills
                .iter()
                .filter_map(|skill| {
                    Some(crate::Skill {
                        name: skill.get("name")?.as_str()?.to_owned(),
                        description: skill
                            .get("description")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        path: skill
                            .get("path")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        source: skill
                            .get("source")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        kind: skill.get("kind").and_then(Value::as_str).map(str::to_owned),
                        disable_model_invocation: skill
                            .get("disableModelInvocation")
                            .and_then(Value::as_bool),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn servers_of(data: &Value) -> Vec<crate::McpServer> {
    use crate::session::McpStatus;

    data.get("servers")
        .and_then(Value::as_array)
        .map(|servers| {
            servers
                .iter()
                .filter_map(|server| {
                    let name = server.get("name")?.as_str()?.to_owned();

                    Some(crate::McpServer {
                        id: server
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or(&name)
                            .to_owned(),
                        name,
                        /*
                         * 认不出的状态落到 Disconnected，不猜成 Connected：猜错会让界面
                         * 画出一个并不存在的连接。
                         */
                        status: match server.get("status").and_then(Value::as_str) {
                            Some("connected") => McpStatus::Connected,
                            Some("connecting") => McpStatus::Connecting,
                            Some("error") => McpStatus::Error,
                            _ => McpStatus::Disconnected,
                        },
                        tool_count: server
                            .get("toolCount")
                            .and_then(Value::as_u64)
                            .and_then(|count| u32::try_from(count).ok())
                            .unwrap_or(0),
                        last_error: server
                            .get("lastError")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 一次授权请求里，界面要的那三格。
struct Approval {
    tool_call_id: String,
    title: String,
    tool_call: Value,
}

/// 上游授权闸门问的那两颗；与 packages/agent-bridge/src/approval.ts 逐字对应。
const APPROVAL_LABELS: [&str; 2] = ["Approve", "Deny"];

/// 这条对话框是不是授权闸门那一句话。
///
/// 判据是「method 为 select，且选项正好是那两颗」：上游没有给授权单独一个 method，
/// 它走的就是普通 select（extensibility/extensions/wrapper.ts 的
/// `select(safetyPrompt, ["Approve", "Deny"])`），靠选项集区分。判据只有这一处 ——
/// 两处各判一次，改一处就会一半认得一半认不得。
fn approval_of(request: &Value) -> Option<Approval> {
    if request.get("method").and_then(Value::as_str) != Some("select") {
        return None;
    }

    let options = request.get("options").and_then(Value::as_array)?;
    let labels: Vec<&str> = options.iter().filter_map(Value::as_str).collect();

    if labels.len() != APPROVAL_LABELS.len()
        || !APPROVAL_LABELS.iter().all(|label| labels.contains(label))
    {
        return None;
    }

    /*
     * 工具名与调用号从标题里取：上游的 select 只给一句话（formatApprovalPrompt
     * 的第一行是 `Allow tool: <name>`），没有结构化的字段。取不到就留空 ——
     * 界面会退到标题那一行，不会因此画不出来。
     */
    let title = request
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();

    let tool_name = title
        .lines()
        .find_map(|line| line.trim().strip_prefix("Allow tool:"))
        .map(str::trim)
        .unwrap_or_default()
        .to_owned();

    let tool_call = serde_json::json!({
        "toolCallId": tool_name.clone(),
        "title": tool_name.clone(),
        "rawInput": title,
    });

    Some(Approval {
        tool_call_id: tool_name,
        title,
        tool_call,
    })
}

/// 产品的一次目录操作 → 线上的形状。
///
/// 与 packages/agent-bridge/src/protocol.ts 的 ModelCatalogOperation 逐字对应。
/// 桥认不出的那些由桥自己如实拒绝 —— 这里不预筛，筛两遍就会一半认得一半认不得。
///
/// 认不出的那种只报**判别式**，绝不 Debug 整条操作：它里面装着 `api_key`，`{:?}`
/// 会把明文密钥写进错误消息、日志和界面（AGENTS.md §5「Debug 不打载荷」）。
fn catalog_operation(operation: &crate::ModelCatalogOperation) -> Value {
    use crate::ModelCatalogOperation as Op;

    match operation {
        Op::Snapshot => serde_json::json!({ "kind": "snapshot" }),
        Op::RefreshProviders => serde_json::json!({ "kind": "refreshProviders" }),
        Op::SetDefault { model_id } => {
            serde_json::json!({ "kind": "setDefault", "modelId": model_id })
        }
        Op::Delete { provider_id } => {
            serde_json::json!({ "kind": "delete", "providerId": provider_id })
        }
        Op::Create(provider) => serde_json::json!({
            "kind": "create",
            "provider": provider_on_wire(provider),
        }),
        Op::Replace {
            provider_id,
            provider,
        } => serde_json::json!({
            "kind": "replace",
            "providerId": provider_id,
            "provider": replacement_on_wire(provider),
        }),
        Op::ImportCatalog(catalog) => serde_json::json!({
            "kind": "importCatalog",
            "catalogId": catalog.catalog_id,
            "apiKey": catalog.api_key,
            "baseUrl": catalog.base_url,
            "id": catalog.id,
        }),
    }
}

/// 一次 provider 输入 → 线上形状（camelCase，与 protocol.ts 的 ProviderInput 对应）。
///
/// 两种输入（Create 的 `ProviderInput` 与 Replace 的 `ProviderReplacement`）字段同名
/// 同义，只有 Replace 多一格 `newId`；所以这里按同一张表搬，那一格由调用方自己带。
///
/// **缺席的格在这里发成 `null`，不是省略。** `serde_json::json!` 把 `Option::None`
/// 序列化成 null，而桥那一侧的 TS 从 JSON 解出来也是 null —— 所以 protocol.ts 里
/// 可缺席的格必须写成 `?: T | null`，下游也只许用 `??` 判，不许用 `=== undefined`。
/// 只写 `undefined` 就会漏掉 null，后面 `.length` 一取就炸（这条已经发生过一次）。
fn provider_on_wire(provider: &crate::model_catalog::ProviderInput) -> Value {
    serde_json::json!({
        "id": provider.id,
        "providerType": provider.provider_type,
        "apiKey": provider.api_key,
        "baseUrl": provider.base_url,
        "defaultModel": provider.default_model,
        "models": models_on_wire(&provider.models),
    })
}

/// 同上，用于整份替换。`newId` 缺省就是不改名。
fn replacement_on_wire(provider: &crate::model_catalog::ProviderReplacement) -> Value {
    serde_json::json!({
        "newId": provider.new_id,
        "providerType": provider.provider_type,
        "apiKey": provider.api_key,
        "baseUrl": provider.base_url,
        "defaultModel": provider.default_model,
        "models": models_on_wire(&provider.models),
    })
}

fn models_on_wire(models: &[crate::model_catalog::ProviderModelInput]) -> Vec<Value> {
    models
        .iter()
        .map(|model| {
            serde_json::json!({
                "model": model.model,
                "maxContextSize": model.max_context_size,
                "displayName": model.display_name,
                "capabilities": model.capabilities,
                "maxOutputSize": model.max_output_size,
                "supportEfforts": model.support_efforts,
                "adaptiveThinking": model.adaptive_thinking,
            })
        })
        .collect()
}

/// 桥报的目录快照 → 产品的形状。
///
/// 桥给的 provider/model 两栏与产品那两栏同名，只是嵌套不同：这一层只做搬运与
/// 缺省，不重新解释任何一格。
fn catalog_snapshot(data: &Value) -> crate::ModelCatalogSnapshot {
    use crate::model_catalog::{
        CatalogModel, CatalogProvider, Model, ModelCatalogSnapshot, Provider,
    };

    let text = |value: &Value, key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);

    let providers =
        data.get("providers")
            .and_then(Value::as_array)
            .map(|providers| {
                providers
                    .iter()
                    .filter_map(|provider| {
                        Some(Provider {
                            id: text(provider, "id")?,
                            provider_type: text(provider, "type").unwrap_or_default(),
                            base_url: text(provider, "baseUrl"),
                            default_model: text(provider, "defaultModel"),
                            has_api_key: provider
                                .get("hasApiKey")
                                .and_then(Value::as_bool)
                                .unwrap_or(false),
                            status: text(provider, "status").unwrap_or_default(),
                            models: provider.get("models").and_then(Value::as_array).map(
                                |models| {
                                    models
                                        .iter()
                                        .filter_map(Value::as_str)
                                        .map(str::to_owned)
                                        .collect()
                                },
                            ),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

    let models = data
        .get("models")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|model| {
                    Some(Model {
                        provider: text(model, "provider")?,
                        model: text(model, "model")?,
                        display_name: text(model, "displayName"),
                        max_context_size: model
                            .get("maxContextSize")
                            .and_then(Value::as_u64)
                            .unwrap_or(0),
                        capabilities: strings(model, "capabilities"),
                        max_output_size: model.get("maxOutputSize").and_then(Value::as_u64),
                        support_efforts: strings(model, "supportEfforts"),
                        adaptive_thinking: model.get("adaptiveThinking").and_then(Value::as_bool),
                        default_effort: text(model, "defaultEffort"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let catalog = data
        .get("catalog")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    Some(CatalogProvider {
                        id: text(entry, "id")?,
                        name: text(entry, "name").unwrap_or_default(),
                        wire_type: text(entry, "wireType"),
                        guessed: entry
                            .get("guessed")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        needs_base_url: entry
                            .get("needsBaseUrl")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        rejected: entry
                            .get("rejected")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        reject_reason: text(entry, "rejectReason"),
                        env_key: text(entry, "envKey"),
                        models: entry
                            .get("models")
                            .and_then(Value::as_array)
                            .map(|models| {
                                models
                                    .iter()
                                    .filter_map(|model| {
                                        Some(CatalogModel {
                                            id: text(model, "id")?,
                                            name: text(model, "name"),
                                            max_context_size: model
                                                .get("maxContextSize")
                                                .and_then(Value::as_u64)
                                                .unwrap_or(0),
                                            capabilities: strings(model, "capabilities"),
                                            reasoning: model
                                                .get("reasoning")
                                                .and_then(Value::as_bool)
                                                .unwrap_or(false),
                                        })
                                    })
                                    .collect()
                            })
                            .unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    ModelCatalogSnapshot {
        providers,
        models,
        catalog,
        default_model: text(data, "defaultModel"),
    }
}

/// 桥报的一条选择器 → 产品控制项。
///
/// purpose 的取值与 packages/agent-bridge/src/protocol.ts 的 SelectorControl
/// 逐字对应。认不出的如实落到 Other，不猜成某一类 —— 猜错会让界面把它画到
/// 错误的住处（模型与思考档位共用一个卡，批准方式是工具条上的胶囊）。
fn control_of(value: &Value) -> Option<crate::ConfigControl> {
    use crate::session::config::{ConfigChoice, ConfigPurpose};

    let id = value.get("id")?.as_str()?.to_owned();
    let purpose = match value.get("purpose").and_then(Value::as_str) {
        Some("model") => ConfigPurpose::Model,
        Some("thinking") => ConfigPurpose::Thought,
        Some("permission") => ConfigPurpose::Permission,
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
    desk: &crate::interaction::desk::PermissionDesk,
    outbound: &AgentClient,
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

        /*
         * 一次对话框请求。
         *
         * 授权那一类（上游的 select，选项正是那四档）翻成产品的一问一答：界面只有
         * 三颗按钮，语义比上游窄，映射只在这里做一次。其余（ask 工具的题目、
         * confirm、input）原样交给宿主 —— 本层不解释它们的形状。
         */
        Event::DialogRequested {
            session_id,
            request,
        } => {
            let request_id = request
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();

            let Some(approval) = approval_of(&request) else {
                let _sent = events_tx.unbounded_send(SessionEvent::Dialog {
                    session_id,
                    request,
                });

                return;
            };

            /* 先落账再等人：账上没有这一条时，人答了也没有东西可对。 */
            if let Ok(Some(slot)) = book.slot(&session_id) {
                slot.record(|recorder| {
                    recorder.record_permission_requested(
                        &request_id,
                        &approval.tool_call_id,
                        &approval.title,
                        approval.tool_call.clone(),
                    );
                });
            }

            /*
             * 桌是这两头的会合点：这一头把「在等人答」登记上去，`answer_permission`
             * 那条命令从另一头把答复送进来。中间那一段必须有人等 —— 不等的话答复
             * 送进一个已经没人读的槽，人点了按钮而 agent 永远卡着。
             */
            match desk.wait(&request_id) {
                Ok(waiting) => {
                    let outbound = outbound.clone();
                    let request = request_id.clone();

                    tokio::spawn(async move {
                        let Ok(response) = waiting.await else {
                            return;
                        };

                        let decision = response.decision.on_wire().to_owned();
                        let scope = response
                            .decision
                            .scope()
                            .map(|scope| scope.on_wire().to_owned());

                        if let Err(error) =
                            outbound.answer_permission(request, decision, scope).await
                        {
                            log::error!("could not hand an approval answer back: {error}");
                        }
                    });
                }
                Err(error) => log::error!("could not put the approval on the desk: {error}"),
            }
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
            goal,
        } => {
            let _sent = events_tx.unbounded_send(SessionEvent::Selectors {
                session_id,
                controls: controls.iter().filter_map(control_of).collect(),
                /* 桥报什么就是什么：缺席（老桥）与「没有目标」在这里都是 None。 */
                goal: goal.as_ref().and_then(goal_of),
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
