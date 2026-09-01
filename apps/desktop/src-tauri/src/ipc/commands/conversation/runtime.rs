//! 一条 agent 连接的一生：起、用、退。
//!
//! 进程活多久 AgentRuntime 就活多久；连接比它短，换 agent 时整条换掉。会话册子
//! 由驱动器交出来，路由帧和这里寻址读的是同一本。
use poietica_conversation::command::Conversation;
use poietica_conversation::ports::{ConversationLedger, PromptDelivery};
use poietica_conversation::turn::DeliveryOutcome;

use super::config::restate;
use super::dto::{AgentLaunch, AgentSessionEvent, reported_goal, reported_usage};
use super::failure::translate;
use super::gateway;
use super::journal::FrameJournal;
use super::{NO_SESSION_ID, POISONED};
use crate::error::{Error, Result};
use crate::ipc::commands::cli::profile::{agent_args, agent_data_home, agent_program, launch_env};
use crate::ipc::commands::ledger::local_index::on_index;
use crate::paths::attachments_root;
use poietica_kap_client::{
    AgentClient, AgentConnection, AgentSpawn, Daemon, DaemonIntent, KapError, LinkState,
    PermissionDesk, QuestionDesk, Reaction, Refusal, RunSlot, SessionBook, SessionEvent, connect,
};
use poietica_ledger::index::{SessionCursor, SessionUsage};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime, State, async_runtime};
use tauri_specta::Event as _;
use tokio::task::LocalSet;
use uuid::Uuid;
/// The live connection, if one has been started.
///
/// 它不持有对话。哪条对话握着哪个会话写在库里，而一条连接自己不是任何人的对话：
/// 此前它在建立时就凭空建一条并 attach 上去，那一行永远没人看、也永远不会被
/// 回收，只能靠列表的过滤条件挡在外面 —— 用每次读列表都要付的一次判断，去遮
/// 一次本不该发生的写入。
#[derive(Debug)]
struct ConnectionLease(AtomicBool);
impl ConnectionLease {
    const fn new() -> Self {
        Self(AtomicBool::new(true))
    }
    fn close(&self) {
        self.0.store(false, Ordering::Release);
    }
    fn is_open(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}
#[derive(Debug)]
struct Connection {
    client: AgentClient,
    lease: Arc<ConnectionLease>,
    /// 这条连接起的是哪个 agent。寻址要拿它跟对话记下的那个比。
    agent_id: String,
    /// 这条连接自带的那个会话号。
    ///
    /// `connect()` 建立连接时就开了它，而没有任何对话持有它 —— 模块头那段注释里
    /// 被吐槽过的"凭空建一条对话"说的就是它当年的下场。它现在有了用途：问这个
    /// agent 提供什么的时候，总得有一个会话可以问，而那个问题与任何一条对话都
    /// 无关。所以它是锚，不是对话的会话。
    anchor: String,
    /// 这条连接的权限台。
    ///
    /// request_id 由 agent 自己发，两个 agent 的号不可通约：共用一张桌子，一个
    /// 答案就可能落到另一个 agent 的问题上。
    desk: PermissionDesk,
    /// 这条连接的提问台。
    ///
    /// 与权限台分开的理由在 agent‑runtime 的 desk.rs：两种「问」对什么算合法答复
    /// 的判据不同。号的归属与上面同理。
    questions: QuestionDesk,
    /// 这条连接开出来的会话，以及各自的记录槽。
    ///
    /// kap 的会话在 server 侧持久（kap‑server 的 resumeSessionById），号跨进程
    /// 有效；命名空间仍然是这个 agent 自己的，另一个 agent 从来不认识它。
    ///
    /// 册子是驱动器的那一本，`connect()` 建立连接时就交了出来。此前这一侧把它
    /// 丢掉，另拿一个 HashSet 记同一件事 —— 于是「这条连接开了哪些会话」在这个
    /// 程序里有三份记载，而只有驱动器手上那一本能决定一帧到底路由到哪里。
    book: SessionBook,
}
/// 这个进程活多久就活多久的那些东西：附件、根目录，以及此刻那一条连接。
///
/// 连接自己的东西不在这里 —— 记录槽、权限台、它开出来的会话号，寿命都是一条
/// 连接。它们此前是这个结构的字段，于是全进程只有一份，而第二个 agent 在结构
/// 上就放不进来。
///
/// 库也不在这里。它是这台机器的东西，不是这个子系统的：工作台那一份与对话
/// 索引同库，而工作台不归 agent 管。它归 commands::ledger::local_index。
#[derive(Debug)]
pub struct AgentRuntime {
    /// 附件字节的根。开机时解析一次：它是布局，不是某条命令的参数。
    pub(super) attachments: PathBuf,
    pub(super) root: PathBuf,
    pub(super) journal: FrameJournal,
    connection: Mutex<Option<Connection>>,
    /// 守着这个进程的那一位：意图与相位的唯一持有处。
    ///
    /// 意图的真相在 settings.json，这里只是它在进程内的那一份；相位从来只在
    /// 这里，落盘会得到一份开机就过期的记载。
    daemon: Mutex<Daemon>,
    /// 起一条连接这件事的排队处。
    ///
    /// 上面那把锁护的是"连接现在是谁"，护不住"谁正在把它建起来"：建连接要
    /// 起进程、要等握手，中间全是 await，而一把 std 的锁不能跨 await 持有。
    /// 于是此前的双重检查发生在握手之后 —— 检查过了，钱已经花完了。
    ///
    /// 这道闸把昂贵的那一段圈进临界区：排在后面的人在闸前等，等到的是前面
    /// 那位建好的连接，而不是自己再起一个进程。它自己不记任何状态，所以
    /// `agent_shutdown` 之后重新起一条连接照样成立 —— 这是它比 `OnceCell` 合适
    /// 的地方，后者一次成型，没有回头路。
    pub(super) starting: tokio::sync::Mutex<()>,
}
impl AgentRuntime {
    /// Tears down the active connection, if any.
    ///
    /// The lock and the `Connection` value never leave this module: callers
    /// express intent, the runtime owns the lifecycle.
    /// # Errors
    ///
    /// Fails when the connection lock is poisoned, or when the frame journal
    /// cannot be flushed.
    pub fn disconnect(&self) -> Result<()> {
        /* 顺序即不变量：先等它起的进程真的没了，再刷日志 —— 反过来的话，收尸
        期间录下的帧排在刷新标记之后，正是退出时会丢的那一段。 */
        const EXIT_GRACE: Duration = Duration::from_secs(5);

        let gone = retire(lock(&self.connection)?.take());

        if gone.is_some_and(|receipt| receipt.recv_timeout(EXIT_GRACE).is_err()) {
            log::warn!("the agent process did not report its exit within {EXIT_GRACE:?}");
        }
        self.journal.flush()?;
        Ok(())
    }
    fn expire(&self, lease: &Arc<ConnectionLease>) -> Result<()> {
        let retired = {
            let mut connection = lock(&self.connection)?;
            if connection
                .as_ref()
                .is_some_and(|live| Arc::ptr_eq(&live.lease, lease))
            {
                connection.take()
            } else {
                None
            }
        };
        let _gone = retire(retired);
        Ok(())
    }
    /// Prepares the runtime without starting anything.
    ///
    /// Starting the agent process at boot would make every launch pay for an unused
    /// feature, so the process is spawned by the first operation that needs the host.
    ///
    /// # Errors
    ///
    /// Fails when the data directory or the home directory cannot be resolved,
    /// or when the data directory cannot be created.
    pub fn new<R: Runtime>(handle: &AppHandle<R>) -> Result<Self> {
        // The session root is resolved here, once, from the platform rather than
        // from the process. A development run starts the binary inside src‑tauri,
        // so the process directory is a build location and never a place the user
        // keeps work.
        let root = handle.path().home_dir()?;
        Ok(Self {
            attachments: attachments_root(handle)?,
            root,
            journal: FrameJournal::new(handle)?,
            connection: Mutex::new(None),
            /* 与 GeneralSettings::default 的 daemon 同一个值。第一次 settings_get
             * 就会把盘上的意图对进来，那之前没有进程可守，两者不会分叉。 */
            daemon: Mutex::new(Daemon::new(DaemonIntent::Running)),
            starting: tokio::sync::Mutex::new(()),
        })
    }
}
/// 让一条连接干净地退场。
///
/// 显式退出与换 agent 是同一件事的两个理由，所以它只写一遍：进程要走、槽里
/// 那位听众要收走、桌上再没有人会来回答、它开出来的会话号也不再指向任何东西。
///
/// 一轮在飞时退场，driver 的 future 被丢掉，那一轮的 Settled::Turn 永远走不完，
/// 于是 RunSlot::take 永远不会被调用。槽现在随连接一起走，所以收不干净只影响
/// 这一条已经作废的连接 —— 此前它是全进程唯一的那一份，一次这样的退出会让
/// 下一条连接的第一轮被误判为已有一轮在飞，而屏幕上那句话答的是另一个问题。
fn retire(taken: Option<Connection>) -> Option<Receiver<()>> {
    let gone = taken?;
    gone.lease.close();
    /* 驱动器已经停了就没有收据可等：它自己退场时已经收过尸。 */
    let receipt = gone.client.shutdown().ok();
    if let Err(error) = gone
        .book
        .fail_active("agent 连接已断开，本轮已终止，请重试")
    {
        log::error!("could not terminate turns owned by a dead connection: {error}");
    }
    gone.desk.clear();
    gone.questions.clear();

    receipt
}
/// What a command needs to know about the running session.
///
/// A connection to speak over, and nothing else. 每条命令都点名一条对话，寻址
/// 由库回答，所以这里再没有第二个答案可以被当成兜底 —— 一个只在「查不到」时才
/// 生效的字段，就是一条只在出错时才走的代码路径。
pub(super) struct Handle {
    pub(super) client: AgentClient,
    /// 这条连接起的是哪个 agent。
    pub(super) agent_id: String,
    /// 这条连接的锚会话。问 agent 能力时发往它。
    pub(super) anchor: String,
    /// 这条连接的权限台。
    pub(super) desk: PermissionDesk,
    /// 这条连接的提问台。
    pub(super) questions: QuestionDesk,
    /// 这条连接的会话册子 —— 驱动器路由帧读的就是它。
    pub(super) book: SessionBook,
}
enum SessionEventPlan {
    Emit(AgentSessionEvent),
    Usage {
        session_id: String,
        usage: SessionUsage,
        payload: AgentSessionEvent,
    },
    Cursor {
        session_id: String,
        cursor: SessionCursor,
    },
    CursorLost {
        session_id: String,
    },
    Link(LinkState),
}
fn plan_session_event(event: SessionEvent) -> SessionEventPlan {
    match event {
        SessionEvent::Selectors {
            session_id,
            controls,
            goal,
        } => SessionEventPlan::Emit(AgentSessionEvent::Selectors {
            session_id,
            selectors: controls.into_iter().map(restate).collect(),
            goal: goal.map(reported_goal),
        }),
        SessionEvent::Usage { session_id, usage } => {
            let reported = reported_usage(usage);
            SessionEventPlan::Usage {
                session_id: session_id.clone(),
                usage: SessionUsage {
                    used: i64::from(reported.used),
                    size: i64::from(reported.size),
                    input_other: i64::from(reported.input_other),
                    input_cache_read: i64::from(reported.input_cache_read),
                    input_cache_creation: i64::from(reported.input_cache_creation),
                },
                payload: AgentSessionEvent::Usage {
                    session_id,
                    usage: reported,
                },
            }
        }
        SessionEvent::Cursor { session_id, cursor } => SessionEventPlan::Cursor {
            session_id,
            cursor: SessionCursor {
                seq: cursor.seq,
                epoch: cursor.epoch,
            },
        },
        SessionEvent::CursorLost { session_id } => SessionEventPlan::CursorLost { session_id },
        SessionEvent::Link(link) => SessionEventPlan::Link(link),
    }
}
async fn publish_session_event(app: &AppHandle, book: &SessionBook, event: SessionEvent) {
    let payload = match plan_session_event(event) {
        SessionEventPlan::Emit(payload) => Some(payload),
        SessionEventPlan::Usage {
            session_id,
            usage,
            payload,
        } => {
            let index = app.state::<crate::ipc::commands::ledger::local_index::LocalIndex>();
            let recorded = on_index(&index, move |store| {
                store
                    .record_usage(&session_id, usage)
                    .map_err(crate::ipc::commands::ledger::local_index::persistence)
            })
            .await;
            if let Err(error) = recorded {
                log::warn!("could not record the session usage: {error}");
            }
            Some(payload)
        }
        SessionEventPlan::Cursor { session_id, cursor } => {
            let index = app.state::<crate::ipc::commands::ledger::local_index::LocalIndex>();
            let recorded = on_index(&index, move |store| {
                store
                    .remember_cursor(&session_id, &cursor)
                    .map_err(crate::ipc::commands::ledger::local_index::persistence)
            })
            .await;
            if let Err(error) = recorded {
                log::warn!("could not record where the event stream was read to: {error}");
            }
            None
        }
        SessionEventPlan::CursorLost { session_id } => {
            let index = app.state::<crate::ipc::commands::ledger::local_index::LocalIndex>();
            let dropped = on_index(&index, move |store| {
                store
                    .forget_cursor(&session_id)
                    .map_err(crate::ipc::commands::ledger::local_index::persistence)
            })
            .await;
            if let Err(error) = dropped {
                log::warn!("could not drop a cursor that no longer resumes: {error}");
            }
            None
        }
        SessionEventPlan::Link(link) => {
            if let Err(error) = book.note_link(&link) {
                log::warn!("could not record the link state: {error}");
            }
            None
        }
    };
    if let Some(payload) = payload
        && let Err(error) = payload.emit(app)
    {
        log::warn!("emit the session state failed: {error}");
    }
}
/// Returns the running session, starting one if there is none.
pub(super) async fn ensure_session(
    app: &AppHandle,
    state: &State<'_, AgentRuntime>,
    launch: AgentLaunch,
    cwd: Option<String>,
) -> Result<Handle> {
    /* 起哪个 agent 是这个函数的第一件事，因为下面每一次「连接已经在了」都要
     * 拿它来问。此前它在函数中段才被解构出来，于是上面那两次检查只问了有没有
     * 连接 —— 换了 agent 之后，这一句话照旧发给上一个进程。 */
    let AgentLaunch { agent_id } = launch;
    if let Some(live) = borrow(state)?
        && live.agent_id == agent_id
    {
        return Ok(live);
    }
    /* 闸前的那一次检查是快路：连接已经在了就不必排队。下面这一段要起进程、
     * 要等握手，两件都很贵，所以它们在闸里边做。 */
    let _gate = state.starting.lock().await;
    /* 排在前面那位可能刚好把连接建起来了。这一次的"没有"是可信的：写
     * state.connection 的地方只有这个函数，而这一刻拿着闸的人只有一个。 */
    if let Some(live) = borrow(state)? {
        if live.agent_id == agent_id {
            return Ok(live);
        }
        /* 换 agent：上一条连接先干净地退场，再起新的。两个 agent 同时常驻是
         * 下一刀的事（那要先让库里那一列的持有者补实）；而把 B 的话发给 A、并
         * 且记成 A 的，今天就是错的。 */
        state.disconnect()?;
    }
    // The agent reads and writes relative to the directory the session was
    // created against, so the fallback has to be somewhere the user actually
    // keeps files. Asking the process where it is answers a different
    // question: under a development run that is the Rust build directory.
    let working_directory = match cwd {
        Some(path) => PathBuf::from(path),
        None => state.root.clone(),
    };
    // 会话拉起前先把浏览器内核预热出来：CDP 端点上要有页面可听，agent 的
    // browser_* 工具才有东西可接。没有端口或已有实例时它是空操作。
    crate::webview::ensure_live_kernel(app);
    let spawn = outfit(app, &agent_id, working_directory.clone())?;
    // The book that files frames under the session that names them belongs
    // to the connection, and the driver holds its own handle to it, so
    // routing works while this side leaves it alone. The runtime takes it
    // over once it keeps more than one session at a time.
    /* 槽、桌子和会话号集合在这里出生，随这条连接一起活。此前它们是
     * AgentRuntime 的字段：全进程一个槽、一张桌子、一份号，而它们的语义分别是
     * 一条会话、一条连接、一条连接。 */
    let slot = RunSlot::new();
    let desk = PermissionDesk::new();
    let questions = QuestionDesk::new();
    /* 运行时先于 connect 构建：起不来就只走这条命令的错误路径，还没有进程需要
     * 善后。build 失败只剩线程资源耗尽一种来路，日志收下细节即可。 */
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| {
            log::error!("could not start the agent background runtime: {error}");
            Error::Internal("the agent background runtime could not start".to_owned())
        })?;
    let AgentConnection {
        client,
        handshake,
        driver,
        events,
        book,
    } = connect(spawn, slot.clone(), desk.clone(), questions.clone()).map_err(translate)?;
    // The composition root owns both the driver and the connection lease.
    let lease = Arc::new(ConnectionLease::new());
    let expired = Arc::clone(&lease);
    let runtime = app.clone();
    /* 重起要用的两样东西在这里定影：进程死掉那一刻，连接已经不在了。 */
    let watched_agent = agent_id.clone();
    let watched_cwd = working_directory;
    let herald = app.clone();
    let linked = book.clone();
    /* driver 与 events 都是 !Send（含本地流/通道），不能直接扔进多线程运行时。
     * 这里在独立线程里跑上面那个单线程运行时，配合 LocalSet 把两个任务托底。 */
    std::thread::spawn(move || {
        let local = LocalSet::new();

        let driver_task = local.spawn_local(async move {
            let outcome = driver.await;
            expired.close();
            if let Err(error) = runtime.state::<AgentRuntime>().expire(&expired) {
                log::error!("could not retire the ended agent connection: {error}");
            }
            let reason = match outcome {
                Ok(()) => "the local agent process exited".to_owned(),
                Err(error) => error.to_string(),
            };
            keep_alive(&runtime, watched_agent, watched_cwd, reason).await;
        });

        let events_task = local.spawn_local(async move {
            let mut events = events;
            while let Some(event) = events.next().await {
                publish_session_event(&herald, &linked, event).await;
            }
        });

        local.block_on(&rt, async move {
            let _ = tokio::join!(driver_task, events_task);
        });
    });
    /* 通道现在两头都说得出话：Canceled 是发送端没了，Err 是握手自己报的原因。 */
    let handshake = handshake
        .await
        .map_err(|_dropped| Error::Internal(NO_SESSION_ID.to_owned()))?
        .map_err(translate)?;
    let session_id = handshake.session_id;
    /* 没有第二个人可以到这里，所以也没有谁需要认输：闸还在手里，而写
     * 这把锁的地方整个模块只有这一处。此前这里有一条"输家把自己起的进程还
     * 回去"的分支，它记的是一笔已经花掉的账 —— 两个人各起了一个 agent 进程、
     * 各做了一次握手，然后杀掉一个。闸把那笔账取消了，分支随之不可达。 */
    let kept = Connection {
        client: client.clone(),
        lease: Arc::clone(&lease),
        agent_id: agent_id.clone(),
        anchor: session_id.clone(),
        desk: desk.clone(),
        questions: questions.clone(),
        book: book.clone(),
    };
    if !lease.is_open() {
        let _gone = retire(Some(kept));
        return Err(translate(KapError::Refused(Refusal::Gone)));
    }
    *lock(&state.connection)? = Some(kept);
    /* 起进程的路只有这一条，所以「起来了」也只在这一处说。 */
    if let Ok(mut daemon) = lock(&state.daemon) {
        daemon.note_started();
    }
    let live = Handle {
        client,
        agent_id,
        anchor: session_id.clone(),
        desk,
        questions,
        book,
    };
    /* 锚会话不必在这里补记：驱动器握手时就把它归进了册子（driver.rs 的
     * `first.adopt`），而这里读的正是同一本。 */
    /* 锚会话生而欠一笔删除。它只属于这条连接，而连接的终点不一定轮得到这
     * 一侧说话 —— 崩溃与开发模式的热重启都没有告别，此前每一次启动因此在
     * agent 的存档里多出一条永远没人再指向的会话。所以账在出生时就落下，由
     * 下一次对上这个 agent 的连接冲销；本连接还在用它（agent_capabilities 与
     * 入口那格的 agent_set_config_option 都发往它），冲账时按当前在役的锚跳过。
     * 冲账挂在握手成功之后，因为送达要的两样这一刻都在手上：活着的连接、对
     * 上号的 agent —— 与 thread.rs 删除时的两个前提是同一张清单。 */
    let ledger = app.clone();
    let courier = live.client.clone();
    let owner = live.agent_id.clone();
    let serving = live.anchor.clone();
    let disposal_lease = Arc::clone(&lease);
    async_runtime::spawn(async move {
        record_and_flush_disposals(&ledger, courier, owner, serving, disposal_lease).await;
    });

    /* 欠着的投递挂在握手成功之后排空：崩溃时停在那里的轮次，幂等键随载荷
     * 上 wire，server 收过就不重复入列。 */
    let herald = app.clone();
    let drain_client = live.client.clone();
    let drain_owner = live.agent_id.clone();
    async_runtime::spawn(async move {
        if let Err(error) = drain_pending_deliveries(&herald, drain_client, &drain_owner).await {
            log::warn!("could not drain the pending deliveries: {error}");
        }
    });
    Ok(live)
}

/// 把发件箱里欠着的投递重新送一遍。
///
/// 会话地址在这里解析（线程索引才有它），只挑当前这个 agent 名下、还握着
/// 会话的那些对话。解析不出的欠账留在线上：它们的主人下一次连上时再来。
async fn drain_pending_deliveries(
    app: &AppHandle,
    client: AgentClient,
    agent_id: &str,
) -> Result<()> {
    let index = app.state::<crate::ipc::commands::ledger::local_index::LocalIndex>();
    let runtime = app.state::<AgentRuntime>();
    let owner = agent_id.to_owned();

    /* 一趟读把两件事问齐：欠账清单，和它们各自的会话地址。 */
    let owed = on_index(&index, move |store| {
        let admissions = store
            .unresolved_deliveries()
            .map_err(|failure| Error::Internal(failure.to_string()))?;

        let mut addressed = Vec::with_capacity(admissions.len());
        for admission in admissions {
            let Ok(thread) = Uuid::parse_str(admission.thread.as_str()) else {
                log::warn!("a pending delivery names a thread that is not a uuid");
                continue;
            };
            let holder = store
                .thread(thread)
                .map_err(crate::ipc::commands::ledger::local_index::persistence)?;
            let session = holder
                .filter(|thread| thread.agent_id.as_deref() == Some(&owner))
                .and_then(|thread| thread.session_id);

            addressed.push((admission, session));
        }

        Ok(addressed)
    })
    .await?;

    for (admission, session) in owed {
        let Some(session) = session else {
            continue;
        };

        let gateway = gateway::KapGateway {
            client: client.clone(),
            journal: runtime.journal.clone(),
            attachments_root: runtime.attachments.clone(),
        };
        let delivery = PromptDelivery {
            admission: admission.clone(),
            session: session.clone(),
        };

        let outcome = on_index(&index, move |store| {
            let conversation = Conversation::new(store, &gateway);

            conversation
                .redeliver(&delivery)
                .map_err(|failure| Error::Internal(failure.to_string()))
        })
        .await?;

        if let Some(receipt) = outcome.receipt {
            /* 收据线在阻塞线程上等到裁决，账随后落那一格。 */
            let turn = admission.turn.clone();
            let settled = on_index(&index, move |store| {
                let verdict = receipt.settle().unwrap_or(DeliveryOutcome::Indeterminate);

                store
                    .record_delivery(&turn, verdict)
                    .map_err(|failure| Error::Internal(failure.to_string()))
            })
            .await;
            if let Err(error) = settled {
                log::warn!("could not record a redelivered turn's outcome: {error}");
            }
        }
        if let Some(failure) = outcome.unresolved {
            log::warn!("a pending delivery could not be sent: {failure}");
        }
    }

    Ok(())
}
/// 这一家在这台机器上怎么起：argv、环境、它读写的那个家，一处算清。
///
/// 程序名与参数来自档案，起的是用户自己装的那个 CLI。受控 home 那个变量由
/// `launch_env` 现算 —— 写 provider 的 CLI 与起会话的连接必须落在同一个目录，
/// 否则 provider 写进了一个 home、对话读的是另一个，界面上添加成功，一开口却说没有
/// 可用的模型。
///
/// # Errors
///
/// 档案缺席、程序名说不出，或数据目录建不出来时返回错误。
fn outfit(app: &AppHandle, agent_id: &str, cwd: PathBuf) -> Result<AgentSpawn> {
    Ok(AgentSpawn {
        program: agent_program(app, agent_id)?,
        args: agent_args(app, agent_id)?,
        cwd,
        env: launch_env(app, agent_id)?,
        home: agent_data_home(app, agent_id)?,
    })
}
/// Reads the session without holding the lock across an await point.
pub(super) fn borrow(state: &State<'_, AgentRuntime>) -> Result<Option<Handle>> {
    let mut guard = lock(&state.connection)?;
    if guard.as_ref().is_some_and(|live| !live.lease.is_open()) {
        let retired = guard.take();
        drop(guard);
        let _gone = retire(retired);
        return Ok(None);
    }
    Ok(guard.as_ref().map(|live| Handle {
        client: live.client.clone(),
        agent_id: live.agent_id.clone(),
        anchor: live.anchor.clone(),
        desk: live.desk.clone(),
        questions: live.questions.clone(),
        book: live.book.clone(),
    }))
}
/// 拿一把本模块的锁。中毒即报错，不静默兜底。
fn lock<T>(held: &Mutex<T>) -> Result<MutexGuard<'_, T>> {
    held.lock()
        .map_err(|_poisoned| Error::Internal(POISONED.to_owned()))
}
/// 让守护进程与用户的意图对上。
///
/// 意图的真相在 settings.json，所以这个函数只从设置命令进来：它自己不读盘、不
/// 缓存那个布尔值 —— 缓存就是第二份真相。
pub async fn apply_daemon_intent(app: &AppHandle, running: bool) {
    let intent = if running {
        DaemonIntent::Running
    } else {
        DaemonIntent::Stopped
    };
    let state = app.state::<AgentRuntime>();
    let reaction = match lock(&state.daemon) {
        Ok(mut daemon) => daemon.set_intent(intent),
        Err(error) => {
            log::error!("could not read the daemon intent: {error}");
            return;
        }
    };
    if reaction == Reaction::Stop
        && let Err(error) = state.disconnect()
    {
        log::warn!("could not stop the local agent daemon: {error}");
    }
}
/// 进程没了之后，守护进程说该怎么办。
///
/// 只在这里问一次，也只在这里动手：重起走 ensure_session 那一条唯一管线，不另
/// 开第二条起进程的路。等待期间用户把开关拨掉，醒来时意图已经是 Stopped，这一
/// 次就什么都不做 —— 取消不需要第二套信号。
async fn keep_alive(app: &AppHandle, agent_id: String, cwd: PathBuf, reason: String) {
    let reaction = {
        let state = app.state::<AgentRuntime>();
        match lock(&state.daemon) {
            Ok(mut daemon) => {
                let reaction = daemon.note_exited(&reason);
                log::info!("local agent daemon is now {:?}", daemon.phase());
                reaction
            }
            Err(error) => {
                log::error!("could not read the daemon phase: {error}");
                return;
            }
        }
    };
    let Reaction::StartAfter(wait) = reaction else {
        return;
    };
    tokio::time::sleep(wait).await;
    let state = app.state::<AgentRuntime>();
    let still_wanted = matches!(
        lock(&state.daemon).map(|daemon| daemon.intent()),
        Ok(DaemonIntent::Running)
    );
    if !still_wanted {
        return;
    }
    let restarted = ensure_session(
        app,
        &state,
        AgentLaunch { agent_id },
        Some(cwd.to_string_lossy().into_owned()),
    )
    .await;
    if let Err(error) = restarted {
        log::warn!("the local agent daemon could not restart the process: {error}");
    }
}
/// 落下当前锚会话的账，然后把这个 agent 名下过期的账逐笔冲销。
///
/// 处置账是「本地已经不认、agent 侧还留着」的会话清单（persistence 的
/// disposals.rs）：离线删除、换号、上一条连接的锚、幽灵行收割都往里记，这
/// 里是唯一的出账口。连接刚建好、还没有一轮在飞，删几条会话花的是没人等的
/// 时间。
///
/// 送达即销账；agent 答了但拒绝也销 —— 拒绝只说明它自己早就不留着，重试不
/// 会让它更认识这个号。只有连接断了（Refusal::Gone）才把余账原样留给下一次
/// 连接。
///
/// 全程只写日志不报错：这是后台清账，任何一步失败都不该打断人正在做的事，
/// 而账还在库里，下一次连接会再来。
async fn record_and_flush_disposals(
    app: &AppHandle,
    client: AgentClient,
    agent_id: String,
    anchor: String,
    lease: Arc<ConnectionLease>,
) {
    let index = app.state::<crate::ipc::commands::ledger::local_index::LocalIndex>();
    let noted = {
        let owner = agent_id.clone();
        let born = anchor.clone();
        on_index(&index, move |store| {
            store
                .record_session_disposal(&born, &owner)
                .map_err(crate::ipc::commands::ledger::local_index::persistence)?;
            store
                .session_disposals(&owner)
                .map_err(crate::ipc::commands::ledger::local_index::persistence)
        })
        .await
    };
    let pending = match noted {
        Ok(pending) => pending,
        Err(error) => {
            log::warn!("could not read the session disposal ledger: {error}");
            return;
        }
    };
    for session_id in pending {
        if !lease.is_open() {
            return;
        }
        /* 当前在役的锚不删，别的都是过期的账。 */
        if session_id == anchor {
            continue;
        }
        let outcome = client.delete_session(session_id.clone()).await;
        if matches!(&outcome, Err(KapError::Refused(Refusal::Gone))) {
            /* 连接没了，这一笔不销：余账留给下一次连接。 */
            return;
        }
        if let Err(error) = outcome {
            log::warn!("a deferred session disposal was refused: {error}");
        }
        let delivered = session_id;
        let discharged = on_index(&index, move |store| {
            store
                .discharge_session_disposal(&delivered)
                .map_err(crate::ipc::commands::ledger::local_index::persistence)
        })
        .await;
        if let Err(error) = discharged {
            log::warn!("could not discharge a session disposal: {error}");
            return;
        }
    }
}
#[cfg(test)]
mod tests {
    #![allow(
        clippy::panic,
        reason = "a failed variant assertion must fail the test loudly"
    )]
    use super::{SessionEventPlan, plan_session_event};
    use poietica_kap_client::{SessionEvent, SessionUsageSnapshot};
    #[test]
    fn usage_plan_is_process_independent() {
        let planned = plan_session_event(SessionEvent::Usage {
            session_id: "session".to_owned(),
            usage: SessionUsageSnapshot {
                used: 12,
                size: 100,
                input_other: 3,
                input_cache_read: 4,
                input_cache_creation: 5,
            },
        });
        let SessionEventPlan::Usage { usage, .. } = planned else {
            panic!("usage must plan a usage write");
        };
        assert_eq!(usage.used, 12);
        assert_eq!(usage.input_cache_creation, 5);
    }
}
