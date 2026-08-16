//! deepseek-harness SDK 运行时这条线的驱动。
//!
//! 与 driver.rs 是同一件事的两条线：那一条说 ACP，这一条说官方
//! @deepseek-ai/dsh-sdk-jsonrpc-server 的换行分隔 JSON-RPC。两条线互不翻译，
//! 唯一共享的是 frame.rs 的 RunFrame —— 成帧在这里做完，此后路由、发号、攒批、
//! 落库与另一条线逐字相同。
//!
//! 线上事实取自官方 packages/sdk/protocol 与 packages/sdk/client/src/client.ts：
//! 三个请求、四条通知、会话号由客户端命名、会话树过滤在客户端、关停是一道阶梯。
//!
//! 这条线没有取消、没有会话装载、没有会话级选择器。harness 核心三样都有
//! （Agent.cancel、ModelSelection、session 持久化），是 SDK 今天没把它们挂上线
//! —— 见 docs/adr/0023。所以这里一处都不假装：拿不到就明说拿不到。

use std::collections::{HashMap, HashSet};
use std::process::Stdio;
use std::time::Duration;

use futures::channel::{mpsc, oneshot};
use futures::{FutureExt, StreamExt};
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command as Process};
use tokio::time::timeout;
use uuid::Uuid;

use crate::commands::{AgentClient, Command};
use crate::desk::PermissionDesk;
use crate::dsh::{
    Incoming, InitializeParams, InitializeResult, Notification, RequestId, SERVER_NAME,
    SessionPromptParams, SessionPromptResult, SessionStatus, decode_line, initialize_line,
    method_not_found_line, prompt_line, shutdown_line,
};
use crate::error::{AcpError, Refusal, Result};
use crate::frame::RunFrame;
use crate::program::resolve_program;
use crate::recorder::Recorder;
use crate::run_slot::RunSlot;
use crate::session::{AgentConnection, AgentSpawn, Handshake, SessionEvents};
use crate::sessions::SessionBook;
use crate::stderr::StderrLog;

/// 官方 SDK 客户端的默认路由（packages/sdk/client/src/types.ts 的
/// DeepSeekHarnessOptions）。provider 与 model 定在握手上，换它们等于换进程。
const DEFAULT_PROVIDER: &str = "deepseek-official";
const DEFAULT_MODEL: &str = "deepseek-v4-flash";

/// 关停阶梯的三档，逐字取自官方 client.ts 的默认值。
const SHUTDOWN_GRACE: Duration = Duration::from_secs(1);
const EOF_GRACE: Duration = Duration::from_secs(6);
const EXIT_GRACE: Duration = Duration::from_secs(3);

/// 一轮的终点是回执之后那一次 idle，所以这条线上「结束」只有一种说法。
const END_TURN: &str = "end_turn";

const NO_STDIO: &str = "运行时进程没有交出标准输入输出";
const NO_IMAGES: &str = "这一条传输还没有取证过图片块的形状，所以不发图片";
const NOT_ON_THIS_LINE: &str = "这一家的 SDK 线上没有这件事";

/// 主循环这一步在处理什么。
enum Step {
    /// 有人下了一条命令，或者命令流断了。
    Asked(Option<Command>),
    /// 运行时说了一行，或者它的标准输出到头了。
    Heard(Option<String>),
}

/// 一件发出去还没回来的请求。
enum Pending {
    Handshake,
    /// 一轮的回执。等到它才开始等这条会话的 idle。
    Receipt {
        session_id: String,
    },
    Shutdown,
}

/// 一轮：回执到了没有，谁在等它的结局。
struct Turn {
    receipted: bool,
    reply: oneshot::Sender<Result<String>>,
}

/// 起运行时进程，握一次手，然后把这条连接保持着。
///
/// 与 ACP 那条线同一个签名同一个返回，所以组合根按档案的 transport 二选一，
/// 下游一个字都不用改。
///
/// 权限桌收下但不用：这条线上服务端从不向客户端发请求，所以没有需要有人回答的
/// 问题（官方 protocol README 把 server→client 请求列为 dead capability）。
///
/// # Errors
///
/// 可执行文件不在搜索路径上、或者进程起不来时报错。
pub fn connect_harness(
    spawn: AgentSpawn,
    slot: RunSlot,
    _desk: PermissionDesk,
) -> Result<AgentConnection> {
    let AgentSpawn {
        program,
        args,
        cwd,
        env,
    } = spawn;

    // 与 ACP 那条线读同一个函数：同一个程序不该有两套找法。
    let resolved = resolve_program(&program)?;

    let mut process = Process::new(resolved);
    process
        .args(&args)
        .current_dir(&cwd)
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // 起子进程不弹控制台窗口。规则与 crates/git 那份同源（各自注明正本，
    // 见 crates/git/src/lib.rs 文件头），GUI 宿主里 spawn 控制台程序必设。
    #[cfg(windows)]
    process.creation_flags(0x0800_0000);

    let mut child = process.spawn().map_err(|error| AcpError::Spawn {
        message: error.to_string(),
    })?;

    let (Some(stdin), Some(stdout), Some(stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        return Err(AcpError::Spawn {
            message: NO_STDIO.to_owned(),
        });
    };

    /* 进程自己说的话。官方 bin 把 usage 与插件加载失败全写在这条流上（见
    packages/examples/jsonrpc-demo 的 README），而配置找不到时它就是唯一的说法。 */
    let diagnostics = StderrLog::new();
    let observed = diagnostics.clone();

    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();

        while let Ok(Some(line)) = lines.next_line().await {
            observed.push(&line);
        }
    });

    let (commands, receiver) = mpsc::unbounded::<Command>();
    /* 出口：会话级状态一条流，直达组合根。这条线上今天一件都不报 —— 选择器与
    用量都不在它的词汇里，所以通道开着但是空的，形状与另一条线一致。 */
    let (events, session_events) = mpsc::unbounded::<crate::session::SessionEvent>();
    let (ready, handshake) = oneshot::channel::<Result<Handshake>>();

    let book = SessionBook::new();
    let ledger = book.clone();

    let driver = async move {
        let mut receiver = receiver;
        let mut lines = BufReader::new(stdout).lines();
        let mut stdin = stdin;
        let mut ready = Some(ready);

        // 在飞的请求，按请求号。
        let mut inflight: HashMap<String, Pending> = HashMap::new();
        // 在飞的轮次，按会话号。一条会话同时只走一轮，那是记录槽的规矩。
        let mut turns: HashMap<String, Turn> = HashMap::new();
        /* 子会话的血缘：child → parent。官方客户端也在自己这边建这张表
        （client.ts 的 sessionParents 与 isDescendantOf）—— 运行时把它上下文里
        每一条会话都报出来，划范围是客户端的事。 */
        let mut parents: HashMap<String, String> = HashMap::new();
        let mut stopping = false;

        /* 锚会话的号由我们发。官方的 session/prompt 对一个没见过的号就地建出
        agent 与会话（packages/sdk/protocol 的 SessionPromptParams），所以这条线上
        「开一条会话」是本地发号，不是一次请求。 */
        let anchor = Uuid::now_v7().to_string();

        let handshake_id = next_id();
        let opening = initialize_line(
            &handshake_id,
            &InitializeParams {
                cwd: cwd.to_string_lossy().into_owned(),
                provider: DEFAULT_PROVIDER.to_owned(),
                model: DEFAULT_MODEL.to_owned(),
                max_tokens: None,
            },
        )?;

        if say(&mut stdin, &opening).await.is_err() {
            answer(&mut ready, Err(handshake_failed(NO_STDIO, &diagnostics)));

            return Ok(());
        }

        inflight.insert(handshake_id, Pending::Handshake);

        loop {
            let step = if stopping {
                Step::Heard(lines.next_line().await.ok().flatten())
            } else {
                tokio::select! {
                    message = receiver.next() => Step::Asked(message),
                    line = lines.next_line() => Step::Heard(line.ok().flatten()),
                }
            };

            match step {
                // 标准输出到头了：进程走了，这条连接跟着结束。
                Step::Heard(None) => break,
                Step::Heard(Some(line)) => {
                    let Some(incoming) = decode_line(&line) else {
                        continue;
                    };

                    match incoming {
                        Incoming::Request { id, method } => {
                            /* 官方传输对没有处理器的请求就答 -32601，这里照做。
                            服务端今天不发请求，所以走到这里说明它长出了新东西，
                            而沉默会让它一直等。 */
                            let _told = say(&mut stdin, &method_not_found_line(&id, &method)).await;
                        }
                        Incoming::Response { id, outcome } => {
                            let RequestId::Text(id) = id else {
                                continue;
                            };

                            let Some(pending) = inflight.remove(&id) else {
                                continue;
                            };

                            match pending {
                                Pending::Handshake => {
                                    let settled = outcome
                                        .map_err(|error| {
                                            handshake_failed(&error.message, &diagnostics)
                                        })
                                        .and_then(|result| identify(result, &diagnostics));

                                    if let Err(failed) = settled {
                                        answer(&mut ready, Err(failed));

                                        break;
                                    }

                                    /* 会话先进册子再交出名字，这样它的第一帧就有
                                    去处 —— 与 ACP 那条线同一条规矩。 */
                                    if ledger.adopt(&anchor, slot.clone()).is_err() {
                                        answer(&mut ready, Err(AcpError::Poisoned));

                                        break;
                                    }

                                    answer(
                                        &mut ready,
                                        Ok(Handshake {
                                            session_id: anchor.clone(),
                                            /* 四张凭证一张都不铸：这条线上没有
                                            session/load、session/delete、session/fork，
                                            也停不了一轮（见 docs/adr/0023）。拿不出
                                            凭证的调用编译不过。 */
                                            loading: None,
                                            deleting: None,
                                            forking: None,
                                            cancelling: None,
                                        }),
                                    );
                                }
                                Pending::Receipt { session_id } => {
                                    match outcome {
                                        // 回执只标记「排上队了」。终点看 idle。
                                        Ok(result) => {
                                            if serde_json::from_value::<SessionPromptResult>(result)
                                                .is_err()
                                            {
                                                settle(
                                                    &mut turns,
                                                    &ledger,
                                                    &diagnostics,
                                                    &session_id,
                                                    Err(AcpError::Protocol {
                                                        message: "运行时的入队回执读不出消息号"
                                                            .to_owned(),
                                                    }),
                                                );

                                                continue;
                                            }

                                            if let Some(turn) = turns.get_mut(&session_id) {
                                                turn.receipted = true;
                                            }
                                        }
                                        Err(error) => settle(
                                            &mut turns,
                                            &ledger,
                                            &diagnostics,
                                            &session_id,
                                            Err(AcpError::Protocol {
                                                message: error.message,
                                            }),
                                        ),
                                    }
                                }
                                // 关停答完了，剩下的交给阶梯。
                                Pending::Shutdown => break,
                            }
                        }
                        Incoming::Notification(Notification::SessionEvent(reported)) => {
                            /* 会话事件是这条线的全部内容。它归到我们开过的那条
                            祖先会话名下 —— 子代理在自己的会话号下说话，而人看的
                            是它父会话那一条对话。 */
                            if let Some(slot) = rooted(&parents, &ledger, &reported.session_id) {
                                let _routed = slot.record(|recorder| {
                                    recorder.record_frame(RunFrame::HarnessEvent {
                                        session_id: reported.session_id.clone(),
                                        event: reported.event.clone(),
                                    });
                                });
                            }
                        }
                        Incoming::Notification(Notification::SessionStatus(reported)) => {
                            /* 一轮的终点：回执之后这条会话回到 idle。状态只在
                            迁移时报，而一条会话同时只走一轮，所以这一次 idle
                            属于且只属于在等它的那一轮。 */
                            if reported.status == SessionStatus::Idle
                                && turns
                                    .get(&reported.session_id)
                                    .is_some_and(|turn| turn.receipted)
                            {
                                settle(
                                    &mut turns,
                                    &ledger,
                                    &diagnostics,
                                    &reported.session_id,
                                    Ok(END_TURN.to_owned()),
                                );
                            }
                        }
                        Incoming::Notification(Notification::SubagentStarted(reported)) => {
                            /* 官方只认 parent 与 child 都在、且互不相同的那一条
                            （client.ts 的 recordSessionRelationship）。 */
                            if !reported.parent_session_id.is_empty()
                                && !reported.child_session_id.is_empty()
                                && reported.parent_session_id != reported.child_session_id
                            {
                                parents
                                    .insert(reported.child_session_id, reported.parent_session_id);
                            }
                        }
                        Incoming::Notification(Notification::SubagentFinished(reported)) => {
                            /* 子代理收尾也是这条对话上发生的事，所以它照样成帧。
                            载荷原样：这一层不认识 SubagentStopReason 的词汇。 */
                            if let Some(slot) =
                                rooted(&parents, &ledger, &reported.child_session_id)
                            {
                                let event = json!({
                                    "type": "subagent/finished",
                                    "data": {
                                        "provider": reported.provider,
                                        "agentId": reported.agent_id,
                                        "parentSessionId": reported.parent_session_id,
                                        "childSessionId": reported.child_session_id,
                                        "stopReason": reported.stop_reason,
                                    },
                                });

                                let _routed = slot.record(|recorder| {
                                    recorder.record_frame(RunFrame::HarnessEvent {
                                        session_id: reported.child_session_id.clone(),
                                        event: event.clone(),
                                    });
                                });
                            }
                        }
                        Incoming::Notification(Notification::Other { method }) => {
                            /* 不认识的通知不静默丢：这条线还在长，而一条查不出
                            由来的缺失比一行日志贵得多。 */
                            log::debug!("harness 报了一件还没有形状的事：{method}");
                        }
                    }
                }
                // 命令流断了，和明说停止是同一件事。
                Step::Asked(None | Some(Command::Shutdown)) => {
                    stopping = true;

                    let id = next_id();

                    if say(&mut stdin, &shutdown_line(&id)).await.is_ok() {
                        inflight.insert(id, Pending::Shutdown);
                    } else {
                        break;
                    }
                }
                Step::Asked(Some(Command::NewSession { reply, .. })) => {
                    /* 本地发号。官方的 prompt 对没见过的号就地把 agent 与会话
                    建出来，所以这里一个请求都不发 —— 会话在第一句话到达时才
                    真的存在。 */
                    let named = Uuid::now_v7().to_string();

                    let opened = ledger
                        .open(&named)
                        .map(|_slot| crate::session::OpenedSession {
                            session_id: named,
                            // 这条线上没有会话级选择器：provider 与 model 定在握手上。
                            selectors: Vec::new(),
                        });

                    let _ignored = reply.send(opened);
                }
                Step::Asked(Some(Command::Prompt {
                    session_id,
                    text,
                    images,
                    frames,
                    reply,
                })) => {
                    if !images.is_empty() {
                        let _ignored = reply.send(Err(AcpError::Protocol {
                            message: NO_IMAGES.to_owned(),
                        }));

                        continue;
                    }

                    let Ok(Some(turn)) = ledger.slot(&session_id) else {
                        let _ignored = reply.send(Err(AcpError::Refused(Refusal::UnknownSession)));

                        continue;
                    };

                    let recorder = Recorder::new(session_id.clone(), turn.seq(), frames);

                    if let Err(error) = turn.install(recorder) {
                        let _ignored = reply.send(Err(error));

                        continue;
                    }

                    /* 错误流是整个进程的。这条线上一次只走一轮，所以它归这一轮。 */
                    diagnostics.clear();

                    let _routed = turn.record(|recorder| {
                        /* 这条线没有图片块（见下方 prompt_line 的注释），
                        所以首帧的 images 恒为空。 */
                        recorder.record_run_started(&text, Vec::new());
                    });

                    let id = next_id();
                    let asked = prompt_line(
                        &id,
                        &SessionPromptParams {
                            session_id: session_id.clone(),
                            /* 文本块的形状有判据（dsh.rs 的 encodes_the_three_requests）。
                            图片块没有，所以上面那一句宁可拒绝也不猜。 */
                            content_blocks: vec![json!({ "type": "text", "text": text })],
                        },
                    )?;

                    if say(&mut stdin, &asked).await.is_err() {
                        let _ignored = reply.send(Err(AcpError::Refused(Refusal::Gone)));

                        continue;
                    }

                    inflight.insert(
                        id,
                        Pending::Receipt {
                            session_id: session_id.clone(),
                        },
                    );
                    turns.insert(
                        session_id,
                        Turn {
                            receipted: false,
                            reply,
                        },
                    );
                }
                /* 凭证没铸，调用点写不出这一句；穷尽匹配仍要求它有个分支。
                真的走到这里，说明凭证漏铸了。 */
                Step::Asked(Some(Command::Cancel { .. })) => {
                    log::error!("{NOT_ON_THIS_LINE}: cancel");
                }
                Step::Asked(Some(
                    Command::LoadSession { reply, .. } | Command::ForkSession { reply, .. },
                )) => {
                    /* 凭证在握手时一张都没铸，所以调用点写不出这两句。穷尽匹配
                    仍然要求它们有个答案。 */
                    let _ignored = reply.send(Err(AcpError::Protocol {
                        message: NOT_ON_THIS_LINE.to_owned(),
                    }));
                }
                Step::Asked(Some(Command::DeleteSession { reply, .. })) => {
                    let _ignored = reply.send(Err(AcpError::Protocol {
                        message: NOT_ON_THIS_LINE.to_owned(),
                    }));
                }
                Step::Asked(Some(Command::Sessions { reply })) => {
                    // 它不列会话：会话日志的持有者是运行时的配置，不是这条线。
                    let _ignored = reply.send(Ok(Vec::new()));
                }
                Step::Asked(Some(Command::Selectors { reply, .. })) => {
                    let _ignored = reply.send(Ok(Vec::new()));
                }
                Step::Asked(Some(Command::Select { reply, .. })) => {
                    let _ignored = reply.send(Err(AcpError::Protocol {
                        message: NOT_ON_THIS_LINE.to_owned(),
                    }));
                }
            }
        }

        /* 还在等结局的那些轮次不会再有答复了：各自落一帧失败，槽一并交回。 */
        for session_id in turns.keys().cloned().collect::<Vec<String>>() {
            settle(
                &mut turns,
                &ledger,
                &diagnostics,
                &session_id,
                Err(AcpError::Refused(Refusal::Gone)),
            );
        }

        // 通道合上，排空任务就此结束。
        drop(events);

        dispose(child, stdin).await;

        Ok(())
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

/// 关停阶梯：先给它自己走的机会，再收紧。
///
/// 三档逐字取自官方 packages/sdk/client/src/dispose.ts —— shutdown 已经发过，
/// 这里是它之后的两档：合上标准输入让它读到 EOF，然后才动手。
///
/// Windows 上没有 SIGTERM，kill 就是 TerminateProcess，所以这道阶梯在那里少
/// 一档 —— 这是平台事实，不是省略。
async fn dispose(mut child: Child, stdin: ChildStdin) {
    if timeout(SHUTDOWN_GRACE, child.wait()).await.is_ok() {
        return;
    }

    // 合上管子：官方 bin 把 stdin EOF 当成一次干净的收尾（exit 0）。
    drop(stdin);

    if timeout(EOF_GRACE, child.wait()).await.is_ok() {
        return;
    }

    let _killed = child.start_kill();
    let _waited = timeout(EXIT_GRACE, child.wait()).await;
}

/// 一行发出去。
async fn say(stdin: &mut ChildStdin, line: &str) -> std::io::Result<()> {
    stdin.write_all(line.as_bytes()).await?;

    stdin.flush().await
}

/// 服务端自报的身份对不对。
///
/// 只认名字。版本没有兼容承诺（官方 protocol README 的 Known Limitations 明说
/// 没有协议版本协商），所以拿它做判据等于凭一个不承诺的东西拒绝启动。
fn identify(result: serde_json::Value, diagnostics: &StderrLog) -> Result<()> {
    let identified: InitializeResult = serde_json::from_value(result)?;

    if identified.server_info.name == SERVER_NAME {
        return Ok(());
    }

    Err(handshake_failed(
        &format!(
            "标准输出上说话的不是 harness 运行时，它自称 {}",
            identified.server_info.name
        ),
        diagnostics,
    ))
}

/// 握手没能走完，说出它为什么没成 —— 连进程自己那几行一起。
///
/// 与 ACP 那条线同一个判断：原因几乎总在它自己的错误流里。这条线上更是如此
/// —— 配置通道两个都不指向存在的文件时，官方 bin 打一行 usage 到 stderr 就
/// exit 1，那一行是唯一的说法。
fn handshake_failed(reported: &str, diagnostics: &StderrLog) -> AcpError {
    let said = diagnostics.tail();

    let message = if said.is_empty() {
        reported.to_owned()
    } else {
        format!("{reported}\n\n运行时在错误流上说：\n{said}")
    };

    AcpError::Handshake { message }
}

/// 把一条会话号归到我们开过的那条祖先会话上。
///
/// 运行时把它上下文里每一条会话都报出来（官方 client.ts：the runtime notifies
/// for every session in its context），划范围是客户端的事。visited 挡的是血缘
/// 成环 —— 官方的 isDescendantOf 同样带一个。
fn rooted(
    parents: &HashMap<String, String>,
    book: &SessionBook,
    session_id: &str,
) -> Option<RunSlot> {
    let mut visited = HashSet::new();
    let mut named = session_id.to_owned();

    loop {
        if !visited.insert(named.clone()) {
            return None;
        }

        if let Ok(Some(slot)) = book.slot(&named) {
            return Some(slot);
        }

        named = parents.get(&named)?.clone();
    }
}

/// 这一轮有了结局：落终帧、释放槽，然后告诉在等它的人。
///
/// 与 install 严格配对 —— 槽不交回去，这条会话的下一轮会撞上 Refusal::Busy。
fn settle(
    turns: &mut HashMap<String, Turn>,
    book: &SessionBook,
    diagnostics: &StderrLog,
    session_id: &str,
    outcome: Result<String>,
) {
    let Some(turn) = turns.remove(session_id) else {
        return;
    };

    if let Ok(Some(slot)) = book.slot(session_id) {
        let said = diagnostics.tail();

        let _recorded = slot.record(|recorder| {
            if !said.is_empty() {
                recorder.set_diagnostics(said);
            }

            match &outcome {
                Ok(stop_reason) => recorder.record_run_finished(stop_reason),
                Err(error) => recorder.record_run_failed(&error.to_string()),
            }
        });

        let _released = slot.take();
    }

    let _ignored = turn.reply.send(outcome);
}

/// 握手的答复只发一次。
fn answer(ready: &mut Option<oneshot::Sender<Result<Handshake>>>, outcome: Result<Handshake>) {
    if let Some(ready) = ready.take() {
        let _ignored = ready.send(outcome);
    }
}

/// 一个请求号。官方客户端用 req_ 加一段去掉横线的 uuid，这里同形。
fn next_id() -> String {
    format!("req_{}", Uuid::now_v7().simple())
}
