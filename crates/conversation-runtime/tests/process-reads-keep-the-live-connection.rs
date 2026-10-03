//! 进程级事实的读不许拆掉用户对话正在用的连接。
//!
//! 模型目录页与入口读传的 cwd 是缺席的（`packages/native-bridge/src/agent/models.ts`
//! 写死 `cwd: null`）。缺席被 `ensure` 解析成兜底工作区，而复用判据是 agent 加工作区
//! （`connection.rs`），于是「读一次目录」把锚在用户工作区上的活连接拆掉重起。
//! 切模型那一趟正好是两个动作背靠背：先改会话选择（成功），再写默认模型（这一读），
//! 于是屏幕上同时出现「这条对话的设置没有改成」与「agent 已经退出」。
//!
//! 判据是起进程的次数：进程级读只允许复用，一次都不许多起。旧实现在这里会数到 3。

#![allow(
    clippy::expect_used,
    reason = "a regression test proves itself by panicking on an unexpected error"
)]

use poietica_agent_client::{AgentSpawn, ProcessEnvironment};
use poietica_conversation_runtime::{
    DeliveryError, OpenThread, Runtime, RuntimeError, ThreadTarget,
    journal::{FrameJournal, JournalError},
};
use poietica_ledger::execution::{IndexError, LocalIndex};
use poietica_time::wall_clock::SystemWallClock;
use std::path::PathBuf;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;

#[derive(Debug, thiserror::Error)]
enum Failure {
    #[error(transparent)]
    Index(#[from] IndexError),
    #[error(transparent)]
    Delivery(#[from] DeliveryError),
    #[error(transparent)]
    Journal(#[from] JournalError),
    #[error(transparent)]
    Runtime(#[from] RuntimeError),
}

/// 随包的三样在 `apps/desktop/resources/agent/`；缺席时跳过而不是失败 ——
/// 没跑 `bun run agent:prepare` 是构建前置条件，不是这条测试的判据。
fn bundled() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/resources/agent")
}

#[tokio::test]
async fn a_process_level_read_reuses_the_live_connection() {
    let bundled = bundled();

    if !bundled.join("poietica-bridge.js").is_file() {
        return;
    }

    let directory = tempfile::tempdir().expect("directory");
    let index = LocalIndex::<Failure>::open(&directory.path().join("ledger.db"), SystemWallClock)
        .expect("index");
    let journal = FrameJournal::new(index.clone(), |_, _| {}).expect("journal");
    let home = directory.path().join("agent-home");
    std::fs::create_dir_all(&home).expect("agent home");

    /*
     * 兜底根（runtime root）与对话的工作区刻意不同：这正是旧实现拆连接的触发条件 ——
     * 缺席的 cwd 落到兜底根，而活连接锚在对话自己的工作区上。
     */
    let root = directory.path().join("fallback-root");
    std::fs::create_dir_all(&root).expect("fallback root");
    let workspace = directory.path().join("workspace");
    std::fs::create_dir_all(&workspace).expect("workspace");

    let spawns = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&spawns);
    let preparing = bundled.clone();
    let agent_home = home.clone();
    let runtime = Runtime::<Failure>::new(
        root,
        directory.path().join("attachments"),
        index,
        journal,
        move |request| {
            counted.fetch_add(1, Ordering::SeqCst);
            let bundled = preparing.clone();
            let home = agent_home.clone();

            Box::pin(async move {
                Ok(AgentSpawn {
                    program: "bun".to_owned(),
                    bundled,
                    entry: "poietica-bridge.js".to_owned(),
                    args: Vec::new(),
                    cwd: request.cwd,
                    env: ProcessEnvironment {
                        set: Vec::new(),
                        remove: Vec::new(),
                    },
                    home,
                })
            })
        },
        |_| {},
    );

    /* 开一条锚在所选工作区上的对话：这一步起一条连接，正好一次。 */
    let thread = uuid::Uuid::new_v4().to_string();
    tokio::time::timeout(
        Duration::from_secs(180),
        runtime.open_thread(OpenThread {
            agent_id: "omp".to_owned(),
            cwd: Some(workspace.to_string_lossy().into_owned()),
            target: ThreadTarget::Create(thread.clone()),
        }),
    )
    .await
    .expect("opening a conversation must not hang")
    .expect("the conversation must open on the bundled agent");

    assert_eq!(
        spawns.load(Ordering::SeqCst),
        1,
        "opening the first conversation must start exactly one connection"
    );

    /*
     * 两条进程级读，cwd 都缺席（屏幕上的真实调用形状）：
     * 入口那几格的选择器读，与模型目录那一页。
     */
    tokio::time::timeout(
        Duration::from_secs(60),
        runtime.configuration_for("omp".to_owned(), None),
    )
    .await
    .expect("the selector read must not hang")
    .expect("the selector read must reuse the live connection");

    tokio::time::timeout(
        Duration::from_secs(60),
        runtime.model_catalog(
            "omp".to_owned(),
            None,
            poietica_agent_client::ModelCatalogOperation::Snapshot,
        ),
    )
    .await
    .expect("the catalog read must not hang")
    .expect("the catalog read must reuse the live connection");

    /*
     * 名册读（入口那一格开机就认领，cwd 缺席）。它与上面两条同属进程级读，判据必须
     * 同一条：写成 ensure 会把 cwd 缺席解析成兜底根，把这条锚在用户工作区上的活连接
     * 拆掉 —— 屏幕上是首启一次「agent 连接失败」，两秒后自愈。
     */
    tokio::time::timeout(
        Duration::from_secs(60),
        runtime.toolkit("omp".to_owned(), None, None),
    )
    .await
    .expect("the roster read must not hang")
    .expect("the roster read must reuse the live connection");

    assert_eq!(
        spawns.load(Ordering::SeqCst),
        1,
        "process-level reads must not tear the conversation's connection down and respawn"
    );

    /* 那条对话仍然活着：重开它不该再起进程（活的连接就够）。 */
    tokio::time::timeout(
        Duration::from_secs(60),
        runtime.open_thread(OpenThread {
            agent_id: "omp".to_owned(),
            cwd: Some(workspace.to_string_lossy().into_owned()),
            target: ThreadTarget::Existing(thread),
        }),
    )
    .await
    .expect("reopening the conversation must not hang")
    .expect("the conversation must still be openable after those reads");

    assert_eq!(
        spawns.load(Ordering::SeqCst),
        1,
        "the conversation's connection must have survived the process-level reads"
    );

    runtime.shutdown().expect("shutdown");
}

/// 带了工作区的读**也不许**重锚：它问的仍是进程级事实，而重锚会拆掉另一条读正在用的
/// 连接。
///
/// 这一条是上面那条的补集，合起来就是唯一判据 —— 进程级读只复用，起进程的判据是
/// 「没有同 agent 的活连接」。此前这里断言的是相反的行为（带工作区就必须重锚），
/// 那正是首启一次「agent 连接失败」的产地：目录读先起一条锚在兜底根上的连接，选择器读
/// 带着工作区把它拆掉重锚，目录读那趟死在半路。
#[tokio::test]
async fn a_read_that_carries_a_workspace_reuses_the_live_connection() {
    let bundled = bundled();

    if !bundled.join("poietica-bridge.js").is_file() {
        return;
    }

    let directory = tempfile::tempdir().expect("directory");
    let index = LocalIndex::<Failure>::open(&directory.path().join("ledger.db"), SystemWallClock)
        .expect("index");
    let journal = FrameJournal::new(index.clone(), |_, _| {}).expect("journal");
    let home = directory.path().join("agent-home");
    std::fs::create_dir_all(&home).expect("agent home");

    let root = directory.path().join("fallback-root");
    std::fs::create_dir_all(&root).expect("fallback root");
    let workspace = directory.path().join("workspace");
    std::fs::create_dir_all(&workspace).expect("workspace");

    let spawns = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&spawns);
    let preparing = bundled.clone();
    let agent_home = home.clone();
    let runtime = Runtime::<Failure>::new(
        root,
        directory.path().join("attachments"),
        index,
        journal,
        move |request| {
            counted.fetch_add(1, Ordering::SeqCst);
            let bundled = preparing.clone();
            let home = agent_home.clone();

            Box::pin(async move {
                Ok(AgentSpawn {
                    program: "bun".to_owned(),
                    bundled,
                    entry: "poietica-bridge.js".to_owned(),
                    args: Vec::new(),
                    cwd: request.cwd,
                    env: ProcessEnvironment {
                        set: Vec::new(),
                        remove: Vec::new(),
                    },
                    home,
                })
            })
        },
        |_| {},
    );

    /*
     * 首启只有一条读、且它带着工作区时：这一读自己起连接，锚必须落在**它请求的工作区**
     * 上，不能落到兜底根。`Reuse` 管的是「有活连接时不重锚」，不是「起新的时锚在哪」。
     */
    tokio::time::timeout(
        Duration::from_secs(180),
        runtime.configuration_for(
            "omp".to_owned(),
            Some(workspace.to_string_lossy().into_owned()),
        ),
    )
    .await
    .expect("the selector read must not hang")
    .expect("the selector read must answer");

    assert_eq!(
        spawns.load(Ordering::SeqCst),
        1,
        "a read that starts the connection must start exactly one"
    );

    /* 随后 cwd 缺席的读要复用那条锚在工作区上的连接，不重锚、不重起。 */
    tokio::time::timeout(
        Duration::from_secs(60),
        runtime.model_catalog(
            "omp".to_owned(),
            None,
            poietica_agent_client::ModelCatalogOperation::Snapshot,
        ),
    )
    .await
    .expect("the catalog read must not hang")
    .expect("the catalog read must answer");

    assert_eq!(
        spawns.load(Ordering::SeqCst),
        1,
        "a cwd-less read must reuse a connection anchored on the workspace"
    );

    /* 带工作区的读同理：复用，不重锚。 */
    tokio::time::timeout(
        Duration::from_secs(60),
        runtime.toolkit(
            "omp".to_owned(),
            Some(workspace.to_string_lossy().into_owned()),
            None,
        ),
    )
    .await
    .expect("the toolkit read must not hang")
    .expect("the toolkit read must answer");

    assert_eq!(
        spawns.load(Ordering::SeqCst),
        1,
        "the roster read must reuse the live connection too"
    );

    runtime.shutdown().expect("shutdown");
}

/// 首启那几条读是**并发**的，且都带着同一个工作区 —— 屏幕上的真实形状：模型目录、选择器、
/// 名册三处读的 cwd 都取自当前工作区。判据是起进程次数恒为 1：谁先跑都得复用同一条，任何
/// 一条拆掉另一条正在用的连接，屏幕上就是首启一次「agent 连接失败」，两秒后自愈。
#[tokio::test]
async fn concurrent_startup_reads_share_one_connection() {
    let bundled = bundled();

    if !bundled.join("poietica-bridge.js").is_file() {
        return;
    }

    let directory = tempfile::tempdir().expect("directory");
    let index = LocalIndex::<Failure>::open(&directory.path().join("ledger.db"), SystemWallClock)
        .expect("index");
    let journal = FrameJournal::new(index.clone(), |_, _| {}).expect("journal");
    let home = directory.path().join("agent-home");
    std::fs::create_dir_all(&home).expect("agent home");
    let root = directory.path().join("fallback-root");
    std::fs::create_dir_all(&root).expect("fallback root");
    let workspace = directory.path().join("workspace");
    std::fs::create_dir_all(&workspace).expect("workspace");

    let spawns = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&spawns);
    let preparing = bundled.clone();
    let agent_home = home.clone();
    let runtime = Runtime::<Failure>::new(
        root,
        directory.path().join("attachments"),
        index,
        journal,
        move |request| {
            counted.fetch_add(1, Ordering::SeqCst);
            let bundled = preparing.clone();
            let home = agent_home.clone();
            Box::pin(async move {
                Ok(AgentSpawn {
                    program: "bun".to_owned(),
                    bundled,
                    entry: "poietica-bridge.js".to_owned(),
                    args: Vec::new(),
                    cwd: request.cwd,
                    env: ProcessEnvironment {
                        set: Vec::new(),
                        remove: Vec::new(),
                    },
                    home,
                })
            })
        },
        |_| {},
    );

    let workspace = workspace.to_string_lossy().into_owned();
    let (catalog, selectors, roster) = tokio::time::timeout(Duration::from_secs(180), async {
        tokio::join!(
            runtime.model_catalog(
                "omp".to_owned(),
                Some(workspace.clone()),
                poietica_agent_client::ModelCatalogOperation::Snapshot,
            ),
            runtime.configuration_for("omp".to_owned(), Some(workspace.clone())),
            runtime.toolkit("omp".to_owned(), Some(workspace), None),
        )
    })
    .await
    .expect("the startup reads must not hang");

    catalog.expect("the catalog read must survive the concurrent startup reads");
    selectors.expect("the selector read must survive the concurrent startup reads");
    roster.expect("the roster read must survive the concurrent startup reads");

    assert_eq!(
        spawns.load(Ordering::SeqCst),
        1,
        "concurrent startup reads must share one connection"
    );

    runtime.shutdown().expect("shutdown");
}

/// 残留竞态：cwd 缺席的进程级读**先**建起连接（锚在兜底根上），随后一条按工作区的读把它
/// 重锚 —— 先建那条手里正在飞的请求会不会死。它与上面的用例是同一条判据的另一半。
#[tokio::test]
async fn a_workspace_read_does_not_tear_down_a_concurrent_process_read() {
    let bundled = bundled();

    if !bundled.join("poietica-bridge.js").is_file() {
        return;
    }

    let directory = tempfile::tempdir().expect("directory");
    let index = LocalIndex::<Failure>::open(&directory.path().join("ledger.db"), SystemWallClock)
        .expect("index");
    let journal = FrameJournal::new(index.clone(), |_, _| {}).expect("journal");
    let home = directory.path().join("agent-home");
    std::fs::create_dir_all(&home).expect("agent home");
    let root = directory.path().join("fallback-root");
    std::fs::create_dir_all(&root).expect("fallback root");
    let workspace = directory.path().join("workspace");
    std::fs::create_dir_all(&workspace).expect("workspace");

    let spawns = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&spawns);
    let preparing = bundled.clone();
    let agent_home = home.clone();
    let runtime = Runtime::<Failure>::new(
        root,
        directory.path().join("attachments"),
        index,
        journal,
        move |request| {
            counted.fetch_add(1, Ordering::SeqCst);
            let bundled = preparing.clone();
            let home = agent_home.clone();
            Box::pin(async move {
                Ok(AgentSpawn {
                    program: "bun".to_owned(),
                    bundled,
                    entry: "poietica-bridge.js".to_owned(),
                    args: Vec::new(),
                    cwd: request.cwd,
                    env: ProcessEnvironment {
                        set: Vec::new(),
                        remove: Vec::new(),
                    },
                    home,
                })
            })
        },
        |_| {},
    );

    let workspace = workspace.to_string_lossy().into_owned();
    let (process, selectors) = tokio::time::timeout(Duration::from_secs(180), async {
        tokio::join!(
            runtime.capability_report("omp".to_owned()),
            runtime.configuration_for("omp".to_owned(), Some(workspace)),
        )
    })
    .await
    .expect("the startup reads must not hang");

    process.expect("the cwd-less process read must survive a concurrent workspace read");
    selectors.expect("the selector read must survive the concurrent startup reads");

    /*
     * 判据落在起进程次数上，不落在「谁先跑完」上：两种锚只允许有一条连接。写成断言顺序
     * 是拿时序当判据 —— 谁先谁后由调度定，两种排法都合法，测出来的却是运气。
     */
    assert_eq!(
        spawns.load(Ordering::SeqCst),
        1,
        "两种锚的进程级读必须共用一条连接，不许重锚重起"
    );

    runtime.shutdown().expect("shutdown");
}
