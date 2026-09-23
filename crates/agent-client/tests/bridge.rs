//! 端到端：Rust 客户端真的能驱动随包发的那个边车。
//!
//! 这条测试是 ADR 0052 的验收：不装 omp、不装 Bun、不装 node_modules，只有
//! `apps/desktop/src-tauri/binaries/` 里那一个可执行文件。它起进程、说 NDJSON、
//! 拿到会话号、问回选择器。
//!
//! 边车不在（没跑 `bun run agent:build`）时跳过而不是失败：那不是这条测试的
//! 判据，是构建前置条件。

#![allow(
    clippy::expect_used,
    reason = "a test proves itself by panicking, so a missing handshake must fail the test"
)]

use std::path::PathBuf;

use poietica_agent_client::{
    AgentSpawn, PermissionDesk, ProcessEnvironment, QuestionDesk, RunSlot, connect,
};

/// 边车落在应用可执行文件旁边；测试进程旁边就是 target/debug。
fn sidecar() -> Option<PathBuf> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let directory = root.join("apps/desktop/src-tauri/binaries");

    let entries = std::fs::read_dir(directory).ok()?;

    entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("poietica-agent"))
        })
}

/// 一个隔离的 agent 目录：不碰这台机器上真实的那一个。
fn home() -> PathBuf {
    let directory =
        std::env::temp_dir().join(format!("poietica-agent-test-{}", std::process::id()));
    let _created = std::fs::create_dir_all(&directory);

    directory
}

#[tokio::test]
async fn the_client_opens_a_session_on_the_bundled_agent() {
    let Some(program) = sidecar() else {
        /* 跳过而不是失败：边车不在是构建前置条件没做，不是这条测试的判据。 */
        return;
    };

    let home = home();
    let workspace = std::env::temp_dir();

    let connection = connect(
        AgentSpawn {
            program: program.to_string_lossy().into_owned(),
            args: Vec::new(),
            cwd: workspace.clone(),
            env: ProcessEnvironment {
                set: Vec::new(),
                remove: Vec::new(),
            },
            home: home.clone(),
        },
        RunSlot::new(),
        &PermissionDesk::default(),
        &QuestionDesk::default(),
    )
    .expect("the agent connection must be constructible");

    /* 驱动器要有人轮询：它就住在那个 future 里，不 spawn 就等于没起进程。 */
    let driver = tokio::spawn(connection.driver);

    let handshake = tokio::time::timeout(std::time::Duration::from_secs(120), connection.handshake)
        .await
        .expect("the handshake must not hang")
        .expect("the driver must answer the handshake");

    let opened = handshake.expect("the bundled agent must open a session");
    assert!(
        !opened.session_id.is_empty(),
        "an opened session must carry an id"
    );

    /* 问一次选择器：证明命令与应答的配对在这条 stdio 上是通的。 */
    let controls = connection
        .client
        .selectors(opened.session_id.clone())
        .expect("the command must be sendable");

    let offered = tokio::time::timeout(std::time::Duration::from_secs(30), controls)
        .await
        .expect("the selector query must not hang")
        .expect("the driver must answer the selector query");

    /* 没有凭据时 omp 报不出模型，所以这里只要求这条往返本身成功 —— 那是本层
    的判据。清单内容归桥那边，不在这一层断言。 */
    let _ = offered;

    connection.stop.cancel();
    let _ = driver.await;

    let _ = std::fs::remove_dir_all(&home);
}

#[tokio::test]
async fn a_sidecar_that_is_not_there_fails_loudly() {
    let connection = connect(
        AgentSpawn {
            program: "poietica-no-such-agent-4f1a".to_owned(),
            args: Vec::new(),
            cwd: std::env::temp_dir(),
            env: ProcessEnvironment {
                set: Vec::new(),
                remove: Vec::new(),
            },
            home: home(),
        },
        RunSlot::new(),
        &PermissionDesk::default(),
        &QuestionDesk::default(),
    );

    /* 找不到程序是构造期的错：握手前就该报，而不是等超时。 */
    assert!(
        connection.is_err(),
        "a missing agent program must be refused before any handshake"
    );
}
