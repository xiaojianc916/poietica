use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    CancelNotification, ContentBlock, DeleteSessionRequest, ForkSessionRequest, ImageContent,
    InitializeRequest, ListSessionsRequest, LoadSessionRequest, McpServer, NewSessionRequest,
    PromptRequest, RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SelectedPermissionOutcome, SessionConfigOption, SessionId, SessionNotification, SessionUpdate,
    SetSessionConfigOptionRequest, TextContent,
};
use agent_client_protocol::{AcpAgent, AcpAgentConfig, Agent, ConnectionTo, LineDirection};
use futures::channel::{mpsc, oneshot};
use futures::stream::FuturesUnordered;
use futures::{FutureExt, StreamExt};
use serde_json::Value;

use crate::commands::{AgentClient, Command, PromptImage};
use crate::config::{ConfigControl, controls, correction};
use crate::desk::PermissionDesk;
use crate::error::{AcpError, Refusal, Result};
use crate::frame::acp_update;
use crate::permission::{Decision, decide};
use crate::program::resolve_program;
use crate::recorder::{Frames, RecordedEvent, Recorder};
use crate::run_slot::{Listening, RunSlot};
use crate::session::{
    AgentConnection, AgentSpawn, CanDeleteSession, CanForkSession, CanLoadSession, Handshake,
    OpenedSession, SessionEntry, SessionEvent, SessionEvents,
};
use crate::sessions::SessionBook;
use crate::stderr::StderrLog;
use crate::trace::{open_trace, trace};

const UNREADABLE: &str = "the agent reported a stop reason the client could not read";

/* 这一句连一个内容块都组不出来。协议没有「空提问」这种东西，所以它不发。 */
const UNSENDABLE: &str = "the prompt carried nothing the protocol could send";

/// 主循环这一步在处理什么。
enum Step {
    /// 有人下了一条命令，或者命令流断了。
    Asked(Option<Command>),
    /// agent 主动报了一件会话级状态，而它要落进主循环手上那张表。
    Noticed(SessionEvent),
    /// 一件在飞的事回来了。
    Settled(Settled),
}

/// 一件做完了的事，以及它落回主循环才能做完的那一半。
///
/// 会话册子只有主循环一个持有者，所以要改它的事都在这里交回去 —— 换来的是
/// 一张锁都不需要。
enum Settled {
    /// 自己就答完了。
    Done,
    Opened {
        opened: Result<Started>,
        reply: oneshot::Sender<Result<OpenedSession>>,
    },
    Selected {
        session_id: String,
        outcome: Result<Vec<ConfigControl>>,
        reply: oneshot::Sender<Result<Vec<ConfigControl>>>,
    },
    Deleted {
        session_id: String,
        outcome: Result<()>,
        reply: oneshot::Sender<Result<()>>,
    },
    /* 这里没有会话号：结算这一轮要用到它的地方只有记录器，而记录器出生时就
    拿着它。 */
    Turn {
        ended: Ended,
        slot: RunSlot,
        reply: oneshot::Sender<Result<String>>,
    },
}

/// 一条刚开出来的会话。
struct Started {
    name: String,
    named: SessionId,
    offered: Vec<ConfigControl>,
    /// 装载一条旧会话时 agent 重放回来的那些帧。新开一条时是空的 —— 一条
    /// 刚开的会话没有历史，这不是缺省值，是事实。
    events: Vec<Value>,
}

/// 一轮是怎么结束的。
///
/// 协议的类型到这里为止：往后走的是已经读得懂的两种结局。被停下的那一轮不在
/// 其中 —— 它照样由 agent 答复，带着协议自己的 `cancelled` 停止原因，所以它是
/// `Finished` 的一种，而不是第三种结局。
enum Ended {
    Finished(String),
    Failed(String),
}

/// Spawns the agent, creates one session, and keeps the connection open.
///
/// Updates are routed through the book. Every frame the agent sends names
/// its session; the book turns that name into that session's slot, and the
/// slot holds a recorder only for as long as that session's turn is in
/// flight. A frame for a session this client never opened, and a frame that
/// arrives between turns, are both dropped rather than attributed to the run
/// that came before them.
///
/// Permission requests are routed through the desk: the handler records the
/// request, waits for an answer that arrives on a different call entirely, and
/// records the answer before returning it to the agent.
///
/// # Errors
///
/// Fails when the program cannot be found on the search path, or when the
/// process cannot be started.
pub fn connect(spawn: AgentSpawn, slot: RunSlot, desk: PermissionDesk) -> Result<AgentConnection> {
    let AgentSpawn {
        program,
        args,
        cwd,
        env,
    } = spawn;

    // 解析规则连同它的病历都在 program.rs 里，provider CLI 那条路径读的是
    // 同一个函数 —— 同一个程序不该有两套找法。
    let resolved = resolve_program(&program)?;

    /* 直接构造，而不是先拼一行命令再让 from_str 用 shell 词法把它切回来 ——
    那一趟往返是有损的：绝对路径的反斜杠会被当成转义符，带空格的路径会被切断。

    command 收的是 impl Into<PathBuf>，which 交回来的就是 PathBuf，无需再转。 */
    let agent = AcpAgent::new(AcpAgentConfig::new(resolved).args(args).envs(env));

    // What the agent says for itself. A provider rejection is reported on the
    // process error stream and the turn still ends normally, so this is the
    // only account of such a turn there is. The SDK offers the stream through
    // its own observer, which is why nothing here reads a pipe.
    let diagnostics = StderrLog::new();
    let observed = diagnostics.clone();

    // The observer sees both halves. Only the standard error half was kept,
    // which left the protocol itself unobservable from inside the client.
    let traced = open_trace();

    let agent = agent.with_debug(move |line, direction| {
        let is_stderr = direction == LineDirection::Stderr;

        if let Some(sink) = traced.as_deref() {
            trace(sink, if is_stderr { "err " } else { "wire" }, line);
        }

        if is_stderr {
            observed.push(line);
        }
    });

    let (commands, receiver) = mpsc::unbounded::<Command>();
    /* 出口：会话级状态一条流，直达组合根。 */
    let (events, session_events) = mpsc::unbounded::<SessionEvent>();
    /* 入站：选择器表要落进主循环私有的那张表，所以它经这条专用通道交给持有者。
    命令表与用量没有持有者，从通知处理器直接进出口。命令流只承载命令。 */
    let (notice_sender, notice_receiver) = mpsc::unbounded::<SessionEvent>();
    let (ready, handshake) = oneshot::channel::<Result<Handshake>>();

    // One book per connection. The handlers live as long as the connection
    // and read it by name; the driver writes to it as sessions are created.
    let book = SessionBook::new();
    let updates = book.clone();
    let permissions = book.clone();
    let first = book.clone();
    let ledger = book.clone();
    let waiting = desk.clone();
    let reported = notice_sender;
    let listed = events.clone();
    let metered = events.clone();

    let driver = async move {
        let served = agent_client_protocol::Client
            .builder()
            .name("poietica")
            .on_receive_notification(
                async move |notification: SessionNotification, _cx| {
                    let named = notification.session_id.to_string();

                    // A frame naming a session this client never opened is
                    // not ours to record, so it is dropped here rather than
                    // written against whichever session happens to be open.
                    // 下面两件事共同的前提就是这一句，所以册子只问一次。
                    if let Ok(Some(slot)) = updates.slot(&named) {
                        /* 会话级状态：到达的时刻多半没有一轮在飞，而轮外的帧
                        会被下面那句 record 丢掉，所以它们走自己的路，不回灌命令流。

                        选择器表交给主循环 —— 它是那张表唯一的持有者。命令表与
                        用量没有持有者，直接进出口。发送失败只有一个由来：通道
                        合上，也就是连接走了，那时已没人要看。 */
                        if let SessionUpdate::ConfigOptionUpdate(update) = &notification.update {
                            let _gone = reported.unbounded_send(SessionEvent::Selectors {
                                session_id: named.clone(),
                                controls: controls(&update.config_options),
                            });
                        }

                        if let Some(offered) = palette_of(&notification.update) {
                            let _gone = listed.unbounded_send(SessionEvent::Commands {
                                session_id: named.clone(),
                                commands: offered,
                            });
                        }

                        if let SessionUpdate::UsageUpdate(update) = &notification.update
                            && let Ok(usage) = serde_json::to_value(update)
                        {
                            let _gone = metered.unbounded_send(SessionEvent::Usage {
                                session_id: named.clone(),
                                usage,
                            });
                        }

                        /* 成帧在这里做完：往下走的是帧，不是协议的类型。
                        工具调用的名字先记进这一轮的工作内存 —— 权限请求可以不带
                        标题，退路就在那张表里。 */
                        let _routed = slot.record(|listening| {
                            if let Some(recorder) = listening.turn_mut() {
                                recorder.note_tool_titles(&notification.update);
                            }

                            match acp_update(&notification) {
                                Ok(frame) => listening.frame(frame),
                                Err(unencodable) => {
                                    listening.unencodable(AcpError::from(unencodable));
                                }
                            }
                        });
                    }

                    Ok(())
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_request(
                async move |request: RequestPermissionRequest, responder, connection| {
                    /* 不在这里等人。SDK 的派发是原子的：一个 on_* 处理器
                    返回之前，这条连接上不再处理任何消息（docs/rfds/rust-sdk-v1.mdx
                    的 Atomic handlers 与 block_task and deadlock）。responder 是
                    Send 的，所以它连同等待一起移进 spawn，派发继续跑。 */
                    let mut opened = None;
                    let named = request.session_id.to_string();

                    // A question belongs to the session that asked it, and
                    // is recorded there or nowhere.
                    if let Ok(Some(slot)) = permissions.slot(&named) {
                        let _routed = slot.record(|listening| {
                            if let Some(recorder) = listening.turn_mut() {
                                opened = Some(recorder.record_permission_requested(&request));
                            }
                        });
                    }

                    // A request arriving outside a turn has nowhere to be
                    // recorded and nobody to answer it. The protocol already
                    // has a word for a question nobody answered: cancelled.
                    // A rejection would claim a refusal no user ever made.
                    let Some(request_id) = opened else {
                        return responder.respond(reply(&Decision::Cancel));
                    };

                    // An unusable desk is our fault, not the agent's, so the
                    // turn is not left hanging on it. Answered on the spot,
                    // because there is nothing to wait for.
                    let Ok(answer) = waiting.wait(&request_id, &request) else {
                        return responder.respond(reply(&decide(&request)));
                    };

                    let book = permissions.clone();

                    connection.spawn(async move {
                        // A dropped sender means the turn ended first, which
                        // is exactly what the protocol calls a cancellation.
                        let decision = answer.await.unwrap_or(Decision::Cancel);

                        // The answer belongs to the same session as the
                        // question, and is recorded there or nowhere.
                        if let Ok(Some(slot)) = book.slot(&named) {
                            let _routed = slot.record(|listening| {
                                if let Some(recorder) = listening.turn_mut() {
                                    recorder.record_permission_resolved(&request_id, &decision);
                                }
                            });
                        }

                        responder.respond(reply(&decision))
                    })
                },
                agent_client_protocol::on_receive_request!(),
            )
            .connect_with(agent, move |connection: ConnectionTo<Agent>| async move {
                let mut receiver = receiver;
                let mut notice_receiver = notice_receiver;

                /* 握手为什么没成，只有这里知道，所以失败要带着原因回去，
                而不是靠丢掉发送端换来一个空的 Canceled。agent 声明的装载能力
                同样只在这一刻说一次。 */
                let initialized = match connection
                    .send_request(InitializeRequest::new(ProtocolVersion::V1))
                    .block_task()
                    .await
                {
                    Ok(initialized) => initialized,
                    Err(error) => {
                        let _ignored =
                            ready.send(Err(handshake_failed(error.to_string(), &diagnostics)));

                        return Err(error);
                    }
                };

                /* 声明过就铸一张凭证。铸造处只有这里，收凭证的是客户端上
                那三个方法：没声明过的能力，调用点根本写不出来。 */
                let loading = initialized
                    .agent_capabilities
                    .load_session
                    .then_some(CanLoadSession::granted());

                /* 删一条会话要不要发给 agent，由 agent 自己在这里说。盲发再
                看它报不报错，是把「它不支持」和「它出错了」混成一件事。 */
                let deleting = initialized
                    .agent_capabilities
                    .session_capabilities
                    .delete
                    .is_some()
                    .then_some(CanDeleteSession::granted());

                /* 分叉同理：ACP 的 session/fork（UNSTABLE，RFD session-fork），
                能力声明在 sessionCapabilities.fork 里。 */
                let forking = initialized
                    .agent_capabilities
                    .session_capabilities
                    .fork
                    .is_some()
                    .then_some(CanForkSession::granted());

                /* 锚会话不挂 MCP。它存在的理由只有一个：读回这个 agent 的选择器
                表（见桌面 seam 的 agent_capabilities）。为它把一批 MCP 服务器拉
                起来，是为一次只读的问答付出一堆进程和握手 —— 而它们的工具这条
                会话一次都不会调。人真正说话的那些会话在 open_session 里开。 */
                let session = match connection
                    .send_request(NewSessionRequest::new(cwd))
                    .block_task()
                    .await
                {
                    Ok(session) => session,
                    Err(error) => {
                        let _ignored =
                            ready.send(Err(handshake_failed(error.to_string(), &diagnostics)));

                        return Err(error);
                    }
                };
                // The agent reports its selectors here and nowhere else,
                // so a list that is dropped now cannot be recovered.
                let offered = match session.config_options.as_deref() {
                    Some(offered) => controls(offered),
                    None => Vec::new(),
                };
                let primary = session.session_id.clone();

                // 每条会话一份：会话名 → (协议 id, 它自己的选择器)。
                //
                // 选择器属于会话而不属于连接：一条会话选了哪个模型，
                // 说明不了另一条选了什么。
                let mut sessions = HashMap::new();
                sessions.insert(primary.to_string(), (primary.clone(), offered));

                // The book is what turns a name into a slot, so this session
                // is entered in it before any frame of it can arrive.
                //
                // A book that cannot be written to could never record this
                // session, so its name is never published: the caller is
                // told by the dropped sender instead of being handed a
                // session that quietly records nothing.
                if first.adopt(&primary.to_string(), slot).is_err() {
                    let _ignored = ready.send(Err(AcpError::Poisoned));

                    return Ok(());
                }

                // Nobody may still be waiting for the identifier, and that is
                // not a failure of the session.
                let _ignored = ready.send(Ok(Handshake {
                    session_id: primary.to_string(),
                    loading,
                    deleting,
                    forking,
                }));

                /*
                 * 在飞的每一件事各是一个未来，一起被推进。
                 *
                 * SDK 自己说得很清楚（concepts/ordering.rs）：block_task 不占用
                 * 派发循环，foreground future 里同时挂多个请求正是它的用法。
                 * 于是主循环只剩两件事：收命令、收结果。
                 *
                 * 用一组未来而不是 spawn，是因为会话册子只有一个持有者时不需要
                 * 任何锁；要改它的事都由结果带回这里落账。
                 */
                let mut jobs: FuturesUnordered<Pin<Box<dyn Future<Output = Settled> + Send + '_>>> =
                    FuturesUnordered::new();

                /* 此刻有几轮在飞。它只服务一件事：错误流是整条连接共有的，
                独自在飞的那一轮才有资格拿它解释自己。取消不看它 —— 停的是
                哪一轮，是 agent 自己知道的事。 */
                let mut in_flight: usize = 0;

                let mut stopping = false;

                loop {
                    let step = if stopping {
                        // 停止之后不再收命令，只把已经在飞的事收完。
                        if jobs.is_empty() {
                            break;
                        }

                        Step::Settled(jobs.select_next_some().await)
                    } else {
                        futures::select! {
                            message = receiver.next() => Step::Asked(message),
                            /* 通道合上时它自报终止，select! 不再轮询它 —— 所以
                            这里的 None 不是一个可达的关停信号。 */
                            notice = notice_receiver.next() => match notice {
                                Some(event) => Step::Noticed(event),
                                None => Step::Settled(Settled::Done),
                            },
                            settled = jobs.select_next_some() => Step::Settled(settled),
                        }
                    };

                    match step {
                        // 命令流断了，和明说停止是同一件事。
                        Step::Asked(None | Some(Command::Shutdown)) => {
                            stopping = true;

                            /* 每条会话都收到一次停止。打在没有轮次在飞的会话
                            上是无害的：协议把取消定为一条通知而不是一次请求，正是
                            因为发出者不必知道对面此刻在做什么。 */
                            for (named, _offered) in sessions.values() {
                                let _told = connection
                                    .send_notification(CancelNotification::new(named.clone()));
                            }
                        }
                        Step::Asked(Some(Command::Cancel { session_id })) => {
                            /* 停一轮就是发一条 session/cancel，ACP 为这件事准备的
                            正是它。此前这里断掉的是一根自己拉的线，而线一断 SDK
                            发出的是 $/cancel_request —— 传输层的「这次调用的结果
                            我不要了」，按请求号寻址；SDK 自己写明了不认识它的对端
                            会直接忽略。agent 该收到的是会话层那一句。 */
                            if let Some((named, _offered)) = sessions.get(&session_id) {
                                let _told = connection
                                    .send_notification(CancelNotification::new(named.clone()));
                            }
                        }
                        Step::Asked(Some(Command::NewSession {
                            cwd,
                            mcp_servers,
                            reply,
                        })) => {
                            jobs.push(Box::pin(open_session(
                                &connection,
                                ledger.clone(),
                                cwd,
                                mcp_servers,
                                reply,
                            )));
                        }
                        Step::Asked(Some(Command::LoadSession {
                            session_id,
                            cwd,
                            reply,
                        })) => {
                            jobs.push(Box::pin(load_session(
                                &connection,
                                ledger.clone(),
                                session_id,
                                cwd,
                                reply,
                            )));
                        }
                        Step::Asked(Some(Command::ForkSession {
                            session_id,
                            cwd,
                            reply,
                        })) => {
                            jobs.push(Box::pin(fork_session(
                                &connection,
                                ledger.clone(),
                                session_id,
                                cwd,
                                reply,
                            )));
                        }
                        Step::Asked(Some(Command::DeleteSession { session_id, reply })) => {
                            jobs.push(Box::pin(delete_session(&connection, session_id, reply)));
                        }
                        Step::Asked(Some(Command::Sessions { reply })) => {
                            jobs.push(Box::pin(list_sessions(&connection, reply)));
                        }
                        /* 选择器表由主循环独占 —— Command::Selectors 就地
                        应答读的就是它。所以 agent 推来的整表在这里落账，然后
                        原样进出口：这一跳是归属，不是过路。 */
                        Step::Noticed(event) => {
                            if let SessionEvent::Selectors {
                                session_id,
                                controls,
                            } = &event
                                && let Some(held) = sessions.get_mut(session_id)
                            {
                                held.1.clone_from(controls);
                            }

                            let _gone = events.unbounded_send(event);
                        }
                        // 读一份列表不需要问 agent，就地答。
                        Step::Asked(Some(Command::Selectors { session_id, reply })) => {
                            let answer = match sessions.get(&session_id) {
                                Some((_named, offered)) => Ok(offered.clone()),
                                None => Err(AcpError::Refused(Refusal::UnknownSession)),
                            };

                            let _ignored = reply.send(answer);
                        }
                        Step::Asked(Some(Command::Select {
                            session_id,
                            config_id,
                            value,
                            reply,
                        })) => {
                            let Some((named, _offered)) = sessions.get(&session_id) else {
                                let _ignored =
                                    reply.send(Err(AcpError::Refused(Refusal::UnknownSession)));

                                continue;
                            };

                            jobs.push(Box::pin(change_selector(
                                &connection,
                                session_id,
                                named.clone(),
                                config_id,
                                value,
                                reply,
                            )));
                        }
                        Step::Asked(Some(Command::Prompt {
                            session_id,
                            text,
                            images,
                            frames,
                            reply,
                        })) => {
                            // 这一轮属于哪条会话，就问哪条会话要它的协议 id 和
                            // 它的槽。接收路径按名字分发的功夫，不能在这里被抵消。
                            let Some((named, _offered)) = sessions.get(&session_id) else {
                                let _ignored =
                                    reply.send(Err(AcpError::Refused(Refusal::UnknownSession)));

                                continue;
                            };
                            let named = named.clone();

                            let Ok(Some(turn)) = ledger.slot(&session_id) else {
                                let _ignored =
                                    reply.send(Err(AcpError::Refused(Refusal::UnknownSession)));

                                continue;
                            };

                            /* 一条会话同时只走一轮 —— 这是记录槽自己的规矩，
                            而它的范围正好是一条会话。"整条连接只许一轮"那道
                            闸门已经没有了：它拦下的是别的对话。 */
                            /* 记录器在这里出生：位置从这条会话的序号线上取，
                            而那条线是槽的，不是这一轮的。 */
                            /* 地址随帧记下：字节接着被 blocks_of 消费掉，而重开这条对话时，
                                    图是从这一帧上认回来的。 */
                                    let shown =
                                        images.iter().map(|image| image.url.clone()).collect();

                                    let recorder = Recorder::new(session_id, turn.seq(), frames);

                            if let Err(error) = turn.install(Listening::Turn(recorder)) {
                                let _ignored = reply.send(Err(error));

                                continue;
                            }

                            /* 错误流是整个进程的，不是某一轮的。此刻没有别的轮
                            在飞，这一轮才有资格把它清空并当成自己的。 */
                            if in_flight == 0 {
                                diagnostics.clear();
                            }

                            // The prompt is recorded before it is sent, so a turn
                            // that fails on the first request still shows what was
                            // asked.
                            let _routed = turn.record(|listening| {
                                if let Some(recorder) = listening.turn_mut() {
                                    recorder.record_run_started(&text, shown);
                                }
                            });

                            in_flight = in_flight.saturating_add(1);

                            jobs.push(Box::pin(run_turn(
                                &connection,
                                named,
                                text,
                                images,
                                turn,
                                reply,
                            )));
                        }
                        Step::Settled(Settled::Done) => {}
                        Step::Settled(Settled::Opened { opened, reply }) => {
                            let answer = opened.map(
                                |Started {
                                     name,
                                     named,
                                     offered,
                                     events,
                                 }| {
                                    sessions.insert(name.clone(), (named, offered.clone()));

                                    OpenedSession {
                                        session_id: name,
                                        selectors: offered,
                                        events,
                                    }
                                },
                            );

                            let _ignored = reply.send(answer);
                        }
                        Step::Settled(Settled::Selected {
                            session_id,
                            outcome,
                            reply,
                        }) => {
                            // 只改这一条会话的那一份。
                            if let Ok(offered) = &outcome
                                && let Some(held) = sessions.get_mut(&session_id)
                            {
                                held.1.clone_from(offered);
                            }

                            let _ignored = reply.send(outcome);
                        }
                        Step::Settled(Settled::Deleted {
                            session_id,
                            outcome,
                            reply,
                        }) => {
                            /* 一条会话存在与否，这里有两份记载：选择器表和会话
                            册子。忘掉一份留下另一份，就是又一个只在出错时才被
                            发现的第二事实来源。 */
                            if outcome.is_ok() {
                                let _forgotten = sessions.remove(&session_id);
                                let _was_open = ledger.close(&session_id);
                            }

                            let _ignored = reply.send(outcome);
                        }
                        Step::Settled(Settled::Turn {
                            ended,
                            slot: turn,
                            reply,
                        }) => {
                            in_flight = in_flight.saturating_sub(1);

                            let Ok(Some(Listening::Turn(mut recorder))) = turn.take() else {
                                let _ignored = reply.send(Err(AcpError::Poisoned));

                                continue;
                            };

                            /* 这一轮结束了，就没人会回答它还开着的那些问题。
                            放掉的只有它自己的：此刻别的会话可能正等着人回答。
                            此前这里清的是整张桌子 —— 那是"一条连接只可能有
                            一轮"时代的写法，几轮同时在飞时它会替别人把问题
                            也一并取消掉。 */
                            desk.abandon(recorder.outstanding_permissions());
                            recorder.record_pending_cancelled();

                            /* 错误流是整条连接共有的：几轮同时在飞时，它不属于
                            其中任何一轮，于是谁也不拿它来解释自己。 */
                            if in_flight == 0 {
                                recorder.set_diagnostics(diagnostics.tail());
                            }

                            let settled = match ended {
                                Ended::Failed(message) => {
                                    recorder.record_run_failed(&message);

                                    Err(AcpError::Protocol { message })
                                }
                                Ended::Finished(reason) => {
                                    recorder.record_run_finished(&reason);

                                    Ok(reason)
                                }
                            };

                            // A write that failed mid-turn could not be reported at
                            // the time, so the turn only counts as successful once
                            // the recorder confirms it.
                            let settled = match recorder.take_failure() {
                                Some(failure) => Err(failure),
                                None => settled,
                            };

                            let _ignored = reply.send(settled);
                        }
                    }
                }

                /* 连接要走了，桌上再没有人会来回答。 */
                desk.clear();

                Ok(())
            })
            .await;

        served.map_err(|error| AcpError::Protocol {
            message: error.to_string(),
        })
    }
    .boxed();

    Ok(AgentConnection {
        book,
        client: AgentClient::new(commands),
        handshake,
        events: SessionEvents::new(session_events),
        driver,
    })
}

/// Opens one more session on a connection that is already running.
async fn open_session(
    connection: &ConnectionTo<Agent>,
    ledger: SessionBook,
    cwd: PathBuf,
    declared: Vec<Value>,
    reply: oneshot::Sender<Result<OpenedSession>>,
) -> Settled {
    let mcp_servers = mcp_servers_of(declared);

    let started = connection
        .send_request(NewSessionRequest::new(cwd).mcp_servers(mcp_servers))
        .block_task()
        .await;

    let opened = match started {
        Err(error) => Err(AcpError::Protocol {
            message: error.to_string(),
        }),
        Ok(session) => {
            let name = session.session_id.to_string();
            let offered = match session.config_options.as_deref() {
                Some(options) => controls(options),
                None => Vec::new(),
            };

            // The session is entered in the book before its name is handed
            // out, so its first frame has somewhere to go.
            ledger.open(&name).map(|_slot| Started {
                name,
                named: session.session_id.clone(),
                offered,
                events: Vec::new(),
            })
        }
    };

    Settled::Opened { opened, reply }
}

/// agent 刚报过来的那张命令表，若这一条通知说的正是它。
///
/// 每一条原样序列化。命令的形状归 ACP 所有，这个 crate 一格都不认识 —— 与
/// `mcp_servers_of` 那一处、停止原因那一处同一条规矩：线上形状才是契约。读不成
/// 的那一条跳过，不让一条坏记录作废整张表。
fn palette_of(update: &SessionUpdate) -> Option<Vec<Value>> {
    let SessionUpdate::AvailableCommandsUpdate(listing) = update else {
        return None;
    };

    Some(
        listing
            .available_commands
            .iter()
            .filter_map(|offered| serde_json::to_value(offered).ok())
            .collect(),
    )
}

/// 线上形状变成协议的类型。
///
/// 反序列化，不是构造：名册从渲染层原样过来，进来就是 JSON，先拆成字段再拼一
/// 个结构体等于自己写一遍 serde。判别式由协议自己钉死：http 与 sse 带 type，
/// stdio 那一支是 untagged。
///
/// 读不成的那一台跳过并留一行日志。整批作废是更坏的选择：一台写错的服务器不该
/// 让这条会话连开都开不起来，而静默丢弃会让它变成一个查不出原因的问题。
fn mcp_servers_of(declared: Vec<Value>) -> Vec<McpServer> {
    let mut servers = Vec::with_capacity(declared.len());

    for value in declared {
        match serde_json::from_value::<McpServer>(value) {
            Ok(server) => servers.push(server),
            Err(error) => log::warn!("could not read a declared MCP server: {error}"),
        }
    }

    servers
}

/// 让 agent 把一条它以前开过的会话重新装载起来。
///
/// 会话号不变，所以历史留在它原来的地方 —— 这正是 `session/load` 与
/// `session/new` 的分别，也是「点开上次运行留下的对话」唯一走得通的路。
///
/// 装载期间 agent 以 `session/update` 把这条会话重放一遍，而那正是这条对话的
/// 历史本身。那些帧走接收路径上同一个入口，所以只要这条会话上有人在听，它们
/// 与当初实时收到的那一批逐字节相同。
///
/// 听的是一位重播听众（[`Listening::Replay`]）：它转发但不落库，所以这段历史
/// 不会在本地留下第二份。
async fn load_session(
    connection: &ConnectionTo<Agent>,
    ledger: SessionBook,
    session_id: String,
    cwd: PathBuf,
    reply: oneshot::Sender<Result<OpenedSession>>,
) -> Settled {
    /* SessionId 自己拥有它的字符串，但那一格是私有的，所以经它的构造函数给它
    一份，而不是自己去初始化那个元组。目标类型写死成 `Arc<str>` 而不是留一个裸
    `.into()`：构造函数收的若是 `impl Into<Arc<str>>`，裸 `.into()` 推不出类型。

    仍然是「给一份」而不是「借一段」—— 这个 crate 上能接 `&str` 的那个 `From`
    要求 `'static`，借来的一段永远满足不了它；拷一次字符串内容，换来的是 `named`
    此后不牵着任何人，下面那句把 `session_id` 交出去才是合法的。 */
    let named = SessionId::new(Arc::<str>::from(session_id.as_str()));

    // 帧要落在这条会话名下，所以它先进册子，再开始装载。
    /* 册子里已有的条目属于一条此刻还活着的会话（同名重装载就是），装载失败
    也不能动它；只有这一次新建的条目，失败了要跟着收回 —— 否则册子与主循环
    的选择器表从这里开始各说各话，而 agent_cancel 判断「有没有东西可停」读的
    正是这本册子。 */
    let fresh = matches!(ledger.slot(&session_id), Ok(None));

    let loaded = match ledger.open(&session_id) {
        Err(unusable) => Err(unusable),
        Ok(slot) => {
            let opened = replay(connection, &slot, session_id.clone(), named, cwd).await;

            if opened.is_err() && fresh {
                let _forgotten = ledger.close(&session_id);
            }

            opened
        }
    };

    Settled::Opened {
        opened: loaded,
        reply,
    }
}

/// 让 agent 从一条已有会话分叉出一条新会话（ACP session/fork）。
///
/// 请求与 session/load 同参，答复与 session/new 同形（RFD session-fork），
/// 所以收尾与 open_session 同一条规矩：新号先进册子，再交出去。
///
/// 没有帧要收：分叉的答复不重放历史。分叉出的对话被打开时，经过走
/// session/load 那条已有的路取回 —— 取历史只有一条管线。
async fn fork_session(
    connection: &ConnectionTo<Agent>,
    ledger: SessionBook,
    session_id: String,
    cwd: PathBuf,
    reply: oneshot::Sender<Result<OpenedSession>>,
) -> Settled {
    /* 与装载、删除同一个理由：构造函数收的是它自己拥有的字符串。 */
    let named = SessionId::new(Arc::<str>::from(session_id.as_str()));

    let forked = connection
        .send_request(ForkSessionRequest::new(named, cwd))
        .block_task()
        .await;

    let opened = match forked {
        Err(error) => Err(AcpError::Protocol {
            message: error.to_string(),
        }),
        Ok(session) => {
            let name = session.session_id.to_string();
            let offered = match session.config_options.as_deref() {
                Some(options) => controls(options),
                None => Vec::new(),
            };

            // The session is entered in the book before its name is handed
            // out, so its first frame has somewhere to go.
            ledger.open(&name).map(|_slot| Started {
                name,
                named: session.session_id.clone(),
                offered,
                events: Vec::new(),
            })
        }
    };

    Settled::Opened { opened, reply }
}

/// 装载一条会话，并把 agent 重放回来的那些帧收下。
///
/// 听众在请求发出之前就位。Zed 出于同一个理由在 await 装载 RPC 之前就把会话
/// 登记进 `sessions`（`crates/agent_servers/src/acp.rs`），否则装载期到达的通知
/// 找不到归属。
async fn replay(
    connection: &ConnectionTo<Agent>,
    slot: &RunSlot,
    session_id: String,
    named: SessionId,
    cwd: PathBuf,
) -> Result<Started> {
    let collected: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&collected);

    /* 重播帧与实时帧同属一条会话，所以它们共用那条会话的序号线：一段历史
    装载回来之后接着往下走，位置不会撞，也不会从头再来。 */
    slot.install(Listening::Replay(Frames::new(
        session_id.clone(),
        slot.seq(),
        Box::new(move |event: RecordedEvent| {
            /* 重播帧在这里定形，理由只有一个：它随 OpenedSession 一起交回
            主循环，而那一格的类型是 Value。实时那条路上一次都不做 —— 帧
            本身就是上屏的形状。两边逐字节相同，因为定形的是同一个类型。 */
            if let Ok(value) = serde_json::to_value(event)
                && let Ok(mut held) = sink.lock()
            {
                held.push(value);
            }
        }),
    )))?;

    let outcome = connection
        .send_request(LoadSessionRequest::new(named.clone(), cwd))
        .block_task()
        .await;

    /* 装载结束，这条会话上不再有人听 —— 下一轮提问要装得进它自己的记录器。 */
    let _listened = slot.take();

    let session = outcome.map_err(|error| AcpError::Protocol {
        message: error.to_string(),
    })?;

    let events = collected
        .lock()
        .map(|mut held| std::mem::take(&mut *held))
        .unwrap_or_default();

    // 装载完了 agent 同样报一次这条会话的选择器，与新开一条对称。
    Ok(Started {
        name: session_id,
        named,
        offered: match session.config_options.as_deref() {
            Some(options) => controls(options),
            None => Vec::new(),
        },
        events,
    })
}

/// 让 agent 也把这条会话删掉。
///
/// 删除一条对话，删的是两份东西：本地那一行索引，和 agent 自己存的那份
/// 会话。ACP 为后者准备了 session/delete —— 只删前者，屏幕上没了而对面
/// 还留着完整的一份。
///
/// 凭证在客户端那一层收（`AgentClient::delete_session`），所以走到这里的一定
/// 声明过。
async fn delete_session(
    connection: &ConnectionTo<Agent>,
    session_id: String,
    reply: oneshot::Sender<Result<()>>,
) -> Settled {
    /* 与装载那条路同一个理由：构造函数收的是它自己拥有的字符串，借来的一段
    满足不了那个 'static 的 From。 */
    let named = SessionId::new(Arc::<str>::from(session_id.as_str()));

    let outcome = match connection
        .send_request(DeleteSessionRequest::new(named))
        .block_task()
        .await
    {
        Ok(_deleted) => Ok(()),
        Err(error) => Err(AcpError::Protocol {
            message: error.to_string(),
        }),
    };

    Settled::Deleted {
        session_id,
        outcome,
        reply,
    }
}

/// Asks the agent for its own list of sessions.
async fn list_sessions(
    connection: &ConnectionTo<Agent>,
    reply: oneshot::Sender<Result<Vec<SessionEntry>>>,
) -> Settled {
    let listed = connection
        .send_request(ListSessionsRequest::new())
        .block_task()
        .await;

    let answer = match listed {
        Ok(response) => Ok(response
            .sessions
            .iter()
            .map(|info| SessionEntry {
                session_id: info.session_id.to_string(),
                title: info.title.clone(),
                updated_at: info.updated_at.clone(),
            })
            .collect()),
        Err(error) => Err(AcpError::Protocol {
            message: error.to_string(),
        }),
    };

    let _ignored = reply.send(answer);

    Settled::Done
}

/// Changes one selector on one session.
async fn change_selector(
    connection: &ConnectionTo<Agent>,
    session_id: String,
    named: SessionId,
    config_id: String,
    value: String,
    reply: oneshot::Sender<Result<Vec<ConfigControl>>>,
) -> Settled {
    let outcome = settle_selector(connection, named, config_id, value).await;

    Settled::Selected {
        session_id,
        outcome,
        reply,
    }
}

/// 一次改动，谈到两边说的是同一件事为止。
///
/// 换模型时 agent 把上一个模型的思考档位带过来，挂在新模型候选集的末尾（见
/// config.rs 的 carried_over）。config::controls 摘掉那一项，屏幕上的档位于是落回
/// 新模型自己的第一档 —— 而 agent 那侧仍然停在旧档上。少了下面这一句回告，屏幕
/// 说的和 agent 做的就是两件事。
///
/// 补的这一句走的是同一条路，所以真相仍然只有一个来源：agent 的答复。本地一格都
/// 不改写。它最多发生一次 —— 一个刚被明确选中的档位不会再被带过来。
async fn settle_selector(
    connection: &ConnectionTo<Agent>,
    named: SessionId,
    config_id: String,
    value: String,
) -> Result<Vec<ConfigControl>> {
    let changed = set_option(connection, named.clone(), config_id, value).await?;
    let settled = controls(&changed);

    let Some((corrected_id, corrected_value)) = correction(&changed, &settled) else {
        return Ok(settled);
    };

    let told = set_option(connection, named, corrected_id, corrected_value).await?;

    Ok(controls(&told))
}

/// One set_config_option, with the agent's own answer carried back.
async fn set_option(
    connection: &ConnectionTo<Agent>,
    named: SessionId,
    config_id: String,
    value: String,
) -> Result<Vec<SessionConfigOption>> {
    connection
        .send_request(SetSessionConfigOptionRequest::new(
            named,
            config_id,
            // The request takes a value the schema can convert, and it
            // converts a borrowed string, not an owned one.
            value.as_str(),
        ))
        .block_task()
        .await
        .map(|response| response.config_options)
        .map_err(|error| AcpError::Protocol {
            message: error.to_string(),
        })
}

/// Walks one turn from the prompt to its end.
///
/// 取消不在这里。一轮怎么结束由 agent 的答复说了算：被停下的那一轮照样答复，
/// 带着协议自己的 `cancelled` 停止原因。此前这里守着一根叫停线，线赢了就丢掉
/// 请求并写死「已取消」—— 于是恰好在按下停止那一刻答完的一轮，本地记的是取消
/// 而 agent 那侧记的是完成，`session/load` 把历史交回来时，两份对不上。
async fn run_turn(
    connection: &ConnectionTo<Agent>,
    named: SessionId,
    text: String,
    images: Vec<PromptImage>,
    slot: RunSlot,
    reply: oneshot::Sender<Result<String>>,
) -> Settled {
    /* 一句话可以带图，也可以只有图。协议的 prompt 收的本来就是一串内容块，
    此前这里写死成一个文本块 —— 那不是协议的限制，是这一行的限制。 */
    let Some(blocks) = blocks_of(&text, images) else {
        return Settled::Turn {
            ended: Ended::Failed(UNSENDABLE.to_owned()),
            slot,
            reply,
        };
    };

    let answered = connection
        .send_request(PromptRequest::new(named, blocks))
        .block_task()
        .await;

    let ended = match answered {
        Err(error) => Ended::Failed(error.to_string()),
        // The wire form is the contract, so the stop reason is taken from
        // serialisation rather than from a hand-written mapping.
        Ok(response) => match serde_json::to_value(response.stop_reason) {
            Ok(Value::String(reason)) => Ended::Finished(reason),
            _unreadable => Ended::Failed(UNREADABLE.to_owned()),
        },
    };

    Settled::Turn { ended, slot, reply }
}

/// 一句话与它带的图片，变成协议要的那串内容块。
///
/// 两种块都由 SDK 的构造函数造。ImageContent 标了 #[non_exhaustive]，官方随之
/// 给了 new(data, mime_type) —— 那就是它留的路，不是绕开它的理由。反序列化留给
/// 本来就是 JSON 的输入，mcp_servers_of 那一处才是。
///
/// 交回 None 只有一种由来：这句话什么都没带，而协议没有「空提问」。
fn blocks_of(text: &str, images: Vec<PromptImage>) -> Option<Vec<ContentBlock>> {
    let mut blocks = Vec::with_capacity(images.len().saturating_add(1));

    if !text.is_empty() {
        blocks.push(ContentBlock::Text(TextContent::new(text.to_owned())));
    }

    for image in images {
        blocks.push(ContentBlock::Image(ImageContent::new(
            image.data,
            image.mime_type,
        )));
    }

    (!blocks.is_empty()).then_some(blocks)
}

/// 握手没能走完，说出它为什么没成 —— 连 agent 自己那句一起。
///
/// initialize 上的 incoming_transport_closed 说的是「对面把管子关了」：那是传输
/// 层看到的现象，不是原因。原因几乎总在 agent 自己的错误流里 —— 可执行文件不在
/// 搜索路径上、它要求先登录、provider 拒了这把密钥、协议版本谈不拢。
///
/// 这条流本来就有人收（stderr.rs 的 StderrLog，留最后 40 行），轮次结束那一路
/// 一直在用它（recorder.set_diagnostics）。只有握手失败这两处一个字都不带，于是
/// 这个应用最容易失败的一步，恰好是唯一一步说不出原因的。
///
/// 不给 AcpError::Handshake 加字段：它的 message 就是「这次握手为什么没成」的
/// 完整说法，agent 那句话属于这同一件事，不是第二格。加一格会打破每一处已经在
/// 按 Handshake { message } 匹配的地方，而它们要显示的仍然是这一句。
///
/// 流可能是空的：进程死得比 observer 收到那几行更快。那种时候就只有传输层这一
/// 句，与此前一样 —— 空着不硬凑，比拼一段 `agent 说：` 后面什么都没有要好。
fn handshake_failed(reported: String, diagnostics: &StderrLog) -> AcpError {
    let said = diagnostics.tail();

    let message = if said.is_empty() {
        reported
    } else {
        format!("{reported}\n\nagent 在错误流上说：\n{said}")
    };

    AcpError::Handshake { message }
}

/// The response that carries a decision back to the agent.
fn reply(decision: &Decision) -> RequestPermissionResponse {
    match decision.option_id() {
        Some(option_id) => RequestPermissionResponse::new(RequestPermissionOutcome::Selected(
            SelectedPermissionOutcome::new(option_id.clone()),
        )),
        None => RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled),
    }
}
