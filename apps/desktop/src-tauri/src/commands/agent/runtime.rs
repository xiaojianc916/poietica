//! 一条 agent 连接的一生：起、用、退。
//!
//! 进程活多久 AgentRuntime 就活多久；连接比它短，换 agent 时整条换掉。会话册子
//! 由驱动器交出来，路由帧和这里寻址读的是同一本。

use crate::commands::agent_setup::profile::{
    agent_args, agent_data_home, agent_program, launch_env,
};
use crate::error::{Error, Result};
use crate::paths::attachments_root;
use poietica_agent_persistence_native::{SessionCursor, SessionUsage};
use poietica_agent_runtime_native::{
    AgentClient, AgentConnection, AgentSpawn, KapError, PermissionDesk, QuestionDesk, Refusal,
    RunSlot, SessionBook, SessionEvent, connect,
};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::{AppHandle, Emitter, Manager, Runtime, State, async_runtime};

use super::config::restate;
use super::dto::{AgentLaunch, AgentSessionEvent, reported_goal, reported_usage};
use super::failure::translate;
use super::journal::FrameJournal;
use super::{AGENT_SESSION_EVENT, NO_SESSION_ID, POISONED};

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
    /// 与权限台分开的理由在 agent-runtime 的 desk.rs：两种「问」对什么算合法答复
    /// 的判据不同。号的归属与上面同理。
    questions: QuestionDesk,
    /// 这条连接开出来的会话，以及各自的记录槽。
    ///
    /// kap 的会话在 server 侧持久（kap-server 的 resumeSessionById），号跨进程
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
/// 索引同库，而工作台不归 agent 管。它归 crate::local_index。
#[derive(Debug)]
pub struct AgentRuntime {
    /// 附件字节的根。开机时解析一次：它是布局，不是某条命令的参数。
    pub(super) attachments: PathBuf,
    pub(super) root: PathBuf,
    pub(super) journal: FrameJournal,
    connection: Mutex<Option<Connection>>,
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
    pub(super) fn disconnect(&self) -> Result<()> {
        retire(lock(&self.connection)?.take());
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

        retire(retired);
        Ok(())
    }

    /// Prepares the runtime without starting anything.
    ///
    /// Starting the agent process at boot would make every launch pay for a
    /// feature the user may never open, so the process is spawned on the
    /// first prompt instead.
    ///
    /// # Errors
    ///
    /// Fails when the data directory or the home directory cannot be resolved,
    /// or when the data directory cannot be created.
    pub fn new<R: Runtime>(handle: &AppHandle<R>) -> Result<Self> {
        // The session root is resolved here, once, from the platform rather than
        // from the process. A development run starts the binary inside src-tauri,
        // so the process directory is a build location and never a place the user
        // keeps work.
        let root = handle.path().home_dir()?;

        Ok(Self {
            attachments: attachments_root(handle)?,
            root,
            journal: FrameJournal::new(handle)?,
            connection: Mutex::new(None),
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
fn retire(taken: Option<Connection>) {
    let Some(gone) = taken else {
        return;
    };

    gone.lease.close();

    // The process is going away either way, so a driver that already
    // stopped is not an error worth reporting.
    let _ignored = gone.client.shutdown();

    if let Err(error) = gone
        .book
        .fail_active("agent 连接已断开，本轮已终止，请重试")
    {
        log::error!("could not terminate turns owned by a dead connection: {error}");
    }

    gone.desk.clear();
    gone.questions.clear();
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

/// Returns the running session, starting one if there is none.
pub(super) async fn ensure_session(
    app: &AppHandle,
    state: &State<'_, AgentRuntime>,
    launch: AgentLaunch,
    cwd: Option<String>,
) -> Result<Handle> {
    /* 起哪个 agent 是这个函数的第一件事，因为下面每一次「连接已经在了」都要
    拿它来问。此前它在函数中段才被解构出来，于是上面那两次检查只问了有没有
    连接 —— 换了 agent 之后，这一句话照旧发给上一个进程。 */
    let AgentLaunch { agent_id } = launch;

    if let Some(live) = borrow(state)?
        && live.agent_id == agent_id
    {
        return Ok(live);
    }

    /* 闸前的那一次检查是快路：连接已经在了就不必排队。下面这一段要起进程、
    要等握手，两件都很贵，所以它们在闸里边做。 */
    let _gate = state.starting.lock().await;

    /* 排在前面那位可能刚好把连接建起来了。这一次的"没有"是可信的：写
    state.connection 的地方只有这个函数，而这一刻拿着闸的人只有一个。 */
    if let Some(live) = borrow(state)? {
        if live.agent_id == agent_id {
            return Ok(live);
        }

        /* 换 agent：上一条连接先干净地退场，再起新的。两个 agent 同时常驻是
        下一刀的事（那要先让库里那一列的持有者补实）；而把 B 的话发给 A、并
        且记成 A 的，今天就是错的。 */
        retire(lock(&state.connection)?.take());
        state.journal.flush()?;
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
    crate::browser::ensure_live_kernel(app);

    let spawn = outfit(app, &agent_id, working_directory)?;

    // The book that files frames under the session that names them belongs
    // to the connection, and the driver holds its own handle to it, so
    // routing works while this side leaves it alone. The runtime takes it
    // over once it keeps more than one session at a time.
    /* 槽、桌子和会话号集合在这里出生，随这条连接一起活。此前它们是
    AgentRuntime 的字段：全进程一个槽、一张桌子、一份号，而它们的语义分别是
    一条会话、一条连接、一条连接。 */
    let slot = RunSlot::new();
    let desk = PermissionDesk::new();
    let questions = QuestionDesk::new();

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

    async_runtime::spawn(async move {
        let outcome = driver.await;

        expired.close();
        if let Err(error) = runtime.state::<AgentRuntime>().expire(&expired) {
            log::error!("could not retire the ended agent connection: {error}");
        }
        if let Err(error) = outcome {
            log::error!("the agent session ended: {error}");
        }
    });

    // agent 主动报来的会话级状态，这里把它送上屏。
    //
    // 一条连接一个排空任务：报告不挂在任何一次往返的答复上，所以没有命令可以
    // 顺路把它带回去。通道关掉（连接没了）时循环自己结束，任务随之退出。
    //
    // 发的是引用：emit 要 Serialize + Clone，而 &T 两样都满足。
    let herald = app.clone();
    let linked = book.clone();

    async_runtime::spawn(async move {
        let mut events = events;

        while let Some(event) = events.next().await {
            let payload = match event {
                SessionEvent::Selectors {
                    session_id,
                    controls,
                    goal,
                } => AgentSessionEvent::Selectors {
                    session_id,
                    selectors: controls.into_iter().map(restate).collect(),
                    goal: goal.map(reported_goal),
                },

                SessionEvent::Usage { session_id, usage } => {
                    let reported = reported_usage(usage);

                    /* 先落账本，再上屏。用量是 volatile 推送（kap 不回放它），
                    装载旧会话也不补报，所以重启之后这一格的唯一来源是账本 ——
                    open 的答复从那里把它带回去。 */
                    let counted = SessionUsage {
                        used: i64::from(reported.used),
                        size: i64::from(reported.size),
                        input_other: i64::from(reported.input_other),
                        input_cache_read: i64::from(reported.input_cache_read),
                        input_cache_creation: i64::from(reported.input_cache_creation),
                    };

                    let index = herald.state::<crate::local_index::LocalIndex>();
                    let session = session_id.clone();

                    let recorded = crate::local_index::on_index(&index, move |store| {
                        store
                            .record_usage(&session, counted)
                            .map_err(crate::local_index::persistence)
                    })
                    .await;

                    /* 记不上只写日志：数字这一刻还是对的，上屏不为一次写失败
                    让路，账本下一轮会再来。 */
                    if let Err(error) = recorded {
                        log::warn!("could not record the session usage: {error}");
                    }

                    AgentSessionEvent::Usage {
                        session_id,
                        usage: reported,
                    }
                }

                /* 链路态进这一轮的账：屏幕上那一行由帧出，所以重启之后它还在。 */
                SessionEvent::Link(link) => {
                    if let Err(error) = linked.note_link(&link) {
                        log::warn!("could not record the link state: {error}");
                    }

                    continue;
                }

                /* 读点是本机的账，屏幕上没有一格画它：落库，不上屏。订阅时由
                addressing.rs 把它报回给 kap。 */
                SessionEvent::Cursor { session_id, cursor } => {
                    let read = SessionCursor {
                        seq: cursor.seq,
                        epoch: cursor.epoch,
                    };

                    let index = herald.state::<crate::local_index::LocalIndex>();

                    let recorded = crate::local_index::on_index(&index, move |store| {
                        store
                            .remember_cursor(&session_id, &read)
                            .map_err(crate::local_index::persistence)
                    })
                    .await;

                    if let Err(error) = recorded {
                        log::warn!("could not record where the event stream was read to: {error}");
                    }

                    continue;
                }

                /* 那一段流断了，读点从它接不下去。 */
                SessionEvent::CursorLost { session_id } => {
                    let index = herald.state::<crate::local_index::LocalIndex>();

                    let dropped = crate::local_index::on_index(&index, move |store| {
                        store
                            .forget_cursor(&session_id)
                            .map_err(crate::local_index::persistence)
                    })
                    .await;

                    if let Err(error) = dropped {
                        log::warn!("could not drop a cursor that no longer resumes: {error}");
                    }

                    continue;
                }
            };

            // 渲染层没在听不是错：下一份报告到达时它仍然是整份。
            let _ignored = herald.emit(AGENT_SESSION_EVENT, &payload);
        }
    });

    /* 通道现在两头都说得出话：Canceled 是发送端没了，Err 是握手自己报的原因。 */
    let handshake = handshake
        .await
        .map_err(|_dropped| Error::Internal(NO_SESSION_ID.to_owned()))?
        .map_err(translate)?;

    let session_id = handshake.session_id;

    /* 没有第二个人可以到这里，所以也没有谁需要认输：闸还在手里，而写
    这把锁的地方整个模块只有这一处。此前这里有一条"输家把自己起的进程还
    回去"的分支，它记的是一笔已经花掉的账 —— 两个人各起了一个 agent 进程、
    各做了一次握手，然后杀掉一个。闸把那笔账取消了，分支随之不可达。 */
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
        retire(Some(kept));
        return Err(translate(KapError::Refused(Refusal::Gone)));
    }

    *lock(&state.connection)? = Some(kept);

    let live = Handle {
        client,
        agent_id,
        anchor: session_id.clone(),
        desk,
        questions,
        book,
    };

    /* 锚会话不必在这里补记：驱动器握手时就把它归进了册子（driver.rs 的
    `first.adopt`），而这里读的正是同一本。 */

    /* 锚会话生而欠一笔删除。它只属于这条连接，而连接的终点不一定轮得到这
    一侧说话 —— 崩溃与开发模式的热重启都没有告别，此前每一次启动因此在
    agent 的存档里多出一条永远没人再指向的会话。所以账在出生时就落下，由
    下一次对上这个 agent 的连接冲销；本连接还在用它（agent_capabilities 与
    入口那格的 agent_set_config_option 都发往它），冲账时按当前在役的锚跳过。

    冲账挂在握手成功之后，因为送达要的两样这一刻都在手上：活着的连接、对
    上号的 agent —— 与 thread.rs 删除时的两个前提是同一张清单。 */
    let ledger = app.clone();
    let courier = live.client.clone();
    let owner = live.agent_id.clone();
    let serving = live.anchor.clone();
    let disposal_lease = Arc::clone(&lease);

    async_runtime::spawn(async move {
        record_and_flush_disposals(&ledger, courier, owner, serving, disposal_lease).await;
    });

    Ok(live)
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
        retire(retired);

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

/// 取那条连接，一句话的功夫。
///
/// 这个结构此前叫 `Session`，而它自己的文档第一行写着「一条连接自己不是任何
/// 人的对话」。会话在这个模块里是一个有精确含义的协议名词：一条连接上有很多
/// 条，每条属于一个对话。把连接叫成会话，等于让每一次读到 `state.connection` 的
/// 人都在脑子里转换一次。
fn lock(connection: &Mutex<Option<Connection>>) -> Result<MutexGuard<'_, Option<Connection>>> {
    connection
        .lock()
        .map_err(|_poisoned| Error::Internal(POISONED.to_owned()))
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
    let index = app.state::<crate::local_index::LocalIndex>();

    let noted = {
        let owner = agent_id.clone();
        let born = anchor.clone();

        crate::local_index::on_index(&index, move |store| {
            store
                .record_session_disposal(&born, &owner)
                .map_err(crate::local_index::persistence)?;

            store
                .session_disposals(&owner)
                .map_err(crate::local_index::persistence)
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

        let discharged = crate::local_index::on_index(&index, move |store| {
            store
                .discharge_session_disposal(&delivered)
                .map_err(crate::local_index::persistence)
        })
        .await;

        if let Err(error) = discharged {
            log::warn!("could not discharge a session disposal: {error}");
            return;
        }
    }
}
