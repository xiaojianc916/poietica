//! 一条 agent 连接的一生：起、用、退。
//!
//! 进程活多久 AgentRuntime 就活多久；连接比它短，换 agent 时整条换掉。会话册子
//! 由驱动器交出来，路由帧和这里寻址读的是同一本。

use crate::commands::agent_setup::profile::launch_env;
use crate::error::{Error, Result};
use crate::paths::attachments_root;
use poietica_agent_persistence_native::SessionUsage;
use poietica_agent_runtime_native::{
    AcpError, AgentClient, AgentConnection, AgentSpawn, PermissionDesk, Refusal, RunSlot,
    SessionBook, connect,
};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Emitter, Manager, Runtime, State, async_runtime};

use super::config::restate;
use super::dto::{
    AgentCommandReport, AgentLaunch, AgentSelectorReport, AgentUsageReport, reported_usage,
};
use super::failure::translate;
use super::{AGENT_COMMAND_EVENT, AGENT_SELECTOR_EVENT, AGENT_USAGE_EVENT, NO_SESSION_ID, POISONED};

/// The live connection, if one has been started.
///
/// 它不持有对话。哪条对话握着哪个会话写在库里，而一条连接自己不是任何人的对话：
/// 此前它在建立时就凭空建一条并 attach 上去，那一行永远没人看、也永远不会被
/// 回收，只能靠列表的过滤条件挡在外面 —— 用每次读列表都要付的一次判断，去遮
/// 一次本不该发生的写入。
#[derive(Debug)]
struct Connection {
    client: AgentClient,
    /// 这条连接起的是哪个 agent。寻址要拿它跟对话记下的那个比。
    agent_id: String,
    /// 这条连接自带的那个会话号。
    ///
    /// `connect()` 建立连接时就开了它，而没有任何对话持有它 —— 模块头那段注释里
    /// 被吐槽过的"凭空建一条对话"说的就是它当年的下场。它现在有了用途：问这个
    /// agent 提供什么的时候，总得有一个会话可以问，而那个问题与任何一条对话都
    /// 无关。所以它是锚，不是对话的会话。
    anchor: String,
    /// 这个 agent 会不会装载一条旧会话。握手时问出来的，一条连接一份。
    can_load_session: bool,
    /// 这个 agent 会不会删掉一条会话。同样是握手问出来的。
    can_delete_session: bool,
    /// 这个 agent 会不会分叉一条会话。同样是握手问出来的。
    can_fork_session: bool,
    /// 这条连接锚会话的记录槽。
    ///
    /// 它的语义是一条会话：driver 建立连接时把它 adopt 到锚会话名下，别的会话
    /// 由册子各开一个。此前它挂在 AgentRuntime 上，也就是说换一条连接要复用
    /// 上一条连接的槽。
    slot: RunSlot,
    /// 这条连接的权限台。
    ///
    /// request_id 由 agent 自己发，两个 agent 的号不可通约：共用一张桌子，一个
    /// 答案就可能落到另一个 agent 的问题上。
    desk: PermissionDesk,
    /// 这条连接开出来的会话，以及各自的记录槽。
    ///
    /// ACP 的 sessionId 只在一条连接内有意义，而且活在这个 agent 自己的命名空间
    /// 里：进程重启之后它不认识上一次的号，另一个 agent 从来不认识它。
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
/// 下一条连接的第一轮撞上 Refusal::Busy，而屏幕上那句话答的是另一个问题。
fn retire(taken: Option<Connection>) {
    let Some(gone) = taken else {
        return;
    };

    // The process is going away either way, so a driver that already
    // stopped is not an error worth reporting.
    let _ignored = gone.client.shutdown();

    /* 拿出来就丢掉。RunSlot::take 的文档写的是把这一位交回去、好让它自己
    收尾，而丢掉正是让它收尾。 */
    let _abandoned = gone.slot.take();

    gone.desk.clear();
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
    /// 这个 agent 会不会装载一条旧会话。寻址要按它分路。
    pub(super) can_load_session: bool,
    /// 这个 agent 会不会删掉一条会话。删除要按它分路。
    pub(super) can_delete_session: bool,
    /// 这个 agent 会不会分叉一条会话。分叉要按它把关。
    pub(super) can_fork_session: bool,
    /// 这条连接的权限台。
    pub(super) desk: PermissionDesk,
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
    let AgentLaunch {
        agent_id,
        program,
        args,
    } = launch;

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

    // 受控 home 在这里被解析成一个环境变量。写 provider 用的是 agent 自己的
    // CLI，起会话用的是这条连接，两边必须指向同一个目录 —— 否则 provider 写
    // 进了一个 home，而对话读的是另一个：界面上 provider 添加成功，一开口却
    // 说没有可用的模型。
    let env = launch_env(app, &agent_id)?;

    let spawn = AgentSpawn {
        program,
        args,
        cwd: working_directory,
        env,
    };

    // The book that files frames under the session that names them belongs
    // to the connection, and the driver holds its own handle to it, so
    // routing works while this side leaves it alone. The runtime takes it
    // over once it keeps more than one session at a time.
    /* 槽、桌子和会话号集合在这里出生，随这条连接一起活。此前它们是
    AgentRuntime 的字段：全进程一个槽、一张桌子、一份号，而它们的语义分别是
    一条会话、一条连接、一条连接。 */
    let slot = RunSlot::new();
    let desk = PermissionDesk::new();

    let AgentConnection {
        client,
        handshake,
        driver,
        reports,
        commands: palette,
        usage,
        book,
    } = connect(spawn, slot.clone(), desk.clone()).map_err(translate)?;

    // The crate is runtime-agnostic on purpose; this is the composition root,
    // so this is where the driver gets an executor.
    async_runtime::spawn(async move {
        if let Err(error) = driver.await {
            log::error!("the agent session ended: {error}");
        }
    });

    // agent 自己改了设置，这里把它送上屏。
    //
    // 一条连接一个排空任务：报告是 agent 主动推的，不挂在任何一次往返的答复
    // 上，所以没有任何命令可以顺路把它带回去。通道关掉（连接没了）时循环自己
    // 结束，任务随之退出。
    //
    // 发的是引用：emit 要 Serialize + Clone，而 &T 两样都满足，上面那条运行帧
    // 通道也是这么发的。为一个只发一次的载荷去 derive Clone 是多余的。
    let herald = app.clone();

    async_runtime::spawn(async move {
        let mut reports = reports;

        while let Some(report) = reports.next().await {
            let payload = AgentSelectorReport {
                session_id: report.session_id,
                selectors: report.controls.into_iter().map(restate).collect(),
            };

            // 渲染层没在听不是错：下一次 open 这条对话仍然会拿到权威的整张表。
            let _ignored = herald.emit(AGENT_SELECTOR_EVENT, &payload);
        }
    });

    // agent 报来的命令表，这里把它送上屏。
    //
    // 一条连接一个排空任务，与上面那一条同一条规矩、同一个理由。表里那些命令是
    // agent 自己算出来的 —— 内置的、它按自己那套目录分层认得的技能、插件带来的
    // —— 本应用不复算，也没有第二处知道它们：界面上那份清单的唯一事实来源就是
    // 这条通道。
    let crier = app.clone();

    async_runtime::spawn(async move {
        let mut palette = palette;

        while let Some(report) = palette.next().await {
            let payload = AgentCommandReport {
                session_id: report.session_id,
                commands: report.commands,
            };

            // 渲染层没在听不是错：下一份报告到达时它仍然是整张表。
            let _ignored = crier.emit(AGENT_COMMAND_EVENT, &payload);
        }
    });

    // agent 报来的上下文用量，这里把它送上屏。
    //
    // 一条连接一个排空任务，与上面两条同一条规矩。Kimi 在轮次落定之后才补报
    // 它，运行帧通道那时按规矩丢帧，所以这条路是它唯一的去处。
    let teller = app.clone();

    async_runtime::spawn(async move {
        let mut usage = usage;

        while let Some(report) = usage.next().await {
            /* 读不成的载荷既进不了账，也不该覆盖屏幕上那一份真话 —— 与命令表
            同一条规矩。 */
            let Some(reported) = reported_usage(&report.usage) else {
                continue;
            };

            /* 先落账本，再上屏。Kimi 只在轮次落定后报一次、装载旧会话时不补报
            （上游 acp-server 的 emitUsageUpdate 只挂在 onTurnEnded 上），所以
            重启后这一格的唯一来源是账本 —— open 的答复从那里把它带回去。 */
            let index = teller.state::<crate::local_index::LocalIndex>();
            let session = report.session_id.clone();

            let counted = SessionUsage {
                used: i64::from(reported.used),
                size: i64::from(reported.size),
            };

            let recorded = crate::local_index::on_index(&index, move |store| {
                store
                    .record_usage(&session, counted)
                    .map_err(crate::local_index::persistence)
            })
            .await;

            /* 记不上只写日志：数字这一刻还是对的，上屏不为一次写失败让路，
            账本下一轮会再来。 */
            if let Err(error) = recorded {
                log::warn!("could not record the session usage: {error}");
            }

            let payload = AgentUsageReport {
                session_id: report.session_id,
                usage: reported,
            };

            // 渲染层没在听不是错：下一份报告到达时它仍然是最新用量。
            let _ignored = teller.emit(AGENT_USAGE_EVENT, &payload);
        }
    });

    /* 通道现在两头都说得出话：Canceled 是发送端没了，Err 是握手自己报的原因。 */
    let handshake = handshake
        .await
        .map_err(|_dropped| Error::Internal(NO_SESSION_ID.to_owned()))?
        .map_err(translate)?;

    let session_id = handshake.session_id;
    let can_load_session = handshake.can_load_session;
    let can_delete_session = handshake.can_delete_session;
    let can_fork_session = handshake.can_fork_session;

    /* 没有第二个人可以到这里，所以也没有谁需要认输：闸还在手里，而写
    这把锁的地方整个模块只有这一处。此前这里有一条"输家把自己起的进程还
    回去"的分支，它记的是一笔已经花掉的账 —— 两个人各起了一个 agent 进程、
    各做了一次握手，然后杀掉一个。闸把那笔账取消了，分支随之不可达。 */
    *lock(&state.connection)? = Some(Connection {
        client: client.clone(),
        agent_id: agent_id.clone(),
        anchor: session_id.clone(),
        can_load_session,
        can_delete_session,
        can_fork_session,
        slot: slot.clone(),
        desk: desk.clone(),
        book: book.clone(),
    });

    let live = Handle {
        client,
        agent_id,
        anchor: session_id.clone(),
        can_load_session,
        can_delete_session,
        can_fork_session,
        desk,
        book,
    };

    /* 锚会话不必在这里补记：驱动器握手时就把它归进了册子（driver.rs 的
    `first.adopt`），而这里读的正是同一本。 */

    /* 锚会话生而欠一笔删除。它只属于这条连接，而连接的终点不一定轮得到这
    一侧说话 —— 崩溃与开发模式的热重启都没有告别，此前每一次启动因此在
    agent 的存档里多出一条永远没人再指向的会话。所以账在出生时就落下，由
    下一次对上这个 agent 的连接冲销；本连接还在用它（agent_capabilities 与
    入口那格的 agent_set_config_option 都发往它），冲账时按当前在役的锚跳过。

    冲账挂在握手成功之后，因为送达要的三样这一刻都在手上：活着的连接、对
    上号的 agent、声明过的能力 —— 与 thread.rs 删除时的三前提是同一张清单。 */
    let ledger = app.clone();
    let courier = live.client.clone();
    let owner = live.agent_id.clone();
    let serving = live.anchor.clone();
    let deliverable = live.can_delete_session;

    async_runtime::spawn(async move {
        record_and_flush_disposals(&ledger, courier, owner, serving, deliverable).await;
    });

    Ok(live)
}

/// Reads the session without holding the lock across an await point.
pub(super) fn borrow(state: &State<'_, AgentRuntime>) -> Result<Option<Handle>> {
    let guard = lock(&state.connection)?;

    Ok(guard.as_ref().map(|live| Handle {
        client: live.client.clone(),
        agent_id: live.agent_id.clone(),
        anchor: live.anchor.clone(),
        can_load_session: live.can_load_session,
        can_delete_session: live.can_delete_session,
        can_fork_session: live.can_fork_session,
        desk: live.desk.clone(),
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
/// 连接。没声明删除能力的 agent 不出账，账在表里等一个声明了能力的版本。
///
/// 全程只写日志不报错：这是后台清账，任何一步失败都不该打断人正在做的事，
/// 而账还在库里，下一次连接会再来。
async fn record_and_flush_disposals(
    app: &AppHandle,
    client: AgentClient,
    agent_id: String,
    anchor: String,
    can_delete_session: bool,
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

    if !can_delete_session {
        return;
    }

    for session_id in pending {
        /* 当前在役的锚不删，别的都是过期的账。 */
        if session_id == anchor {
            continue;
        }

        let outcome = client.delete_session(session_id.clone()).await;

        if matches!(&outcome, Err(AcpError::Refused(Refusal::Gone))) {
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
