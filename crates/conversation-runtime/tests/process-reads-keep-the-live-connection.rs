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

/// 带了工作区的读必须按工作区锚，不能复用一条锚在别处的活连接。
///
/// 首启那三条读并发就是这样撞上的：目录读传 `cwd: null`，先起一条锚在兜底根上的连接；
/// 选择器读带着工作区紧随其后，若它复用那条兜底连接，随后按工作区锚的名册读就会把这条
/// 连接拆掉 —— 拆的正是还在服务选择器读的那条，于是首启必现一次「agent 连接失败」。
///
/// 判据是这一读自己起没起进程：带工作区而活连接锚在兜底根上时，它必须重锚。
#[tokio::test]
async fn a_read_that_carries_a_workspace_reanchors_the_connection() {
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

    /* 首启第一条读：cwd 缺席，落一条锚在兜底根上的连接。 */
    tokio::time::timeout(
        Duration::from_secs(180),
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
        "a cwd-less read must anchor on the fallback root"
    );

    /*
     * 首启第二条读：带着工作区。它自己必须重锚 —— 复用兜底那条会让名册读把它拆掉，
     * 而它正挂在上面。
     */
    tokio::time::timeout(
        Duration::from_secs(60),
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
        2,
        "a read carrying a workspace must re-anchor, not reuse a connection anchored elsewhere"
    );

    /* 随后按同一工作区的读要复用重锚后的那条，不再起进程。 */
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
        2,
        "a read on the already-anchored workspace must reuse its connection"
    );

    runtime.shutdown().expect("shutdown");
}
