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

    /*
     * 打开一条会话要走的两条读：目标与正文基线。
     *
     * 这两条此前答「还没接」，而 `open_thread` 把它们放在同一个 try_join 里，
     * 于是每一次发消息都在这里断掉（屏幕上就是 ProblemError: the goal switch is
     * not wired to this agent yet）。所以这里的判据是「它们真的答得上话」。
     */
    let goal = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        connection.client.goal(opened.session_id.clone()),
    )
    .await
    .expect("the goal query must not hang")
    .expect("the driver must answer the goal query");

    /* 没有目标就是没有：新建的会话本就不该有目标。 */
    assert!(goal.is_none(), "a fresh session must not report a goal");

    let page = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        connection
            .client
            .read_transcript(opened.session_id.clone(), "main".to_owned(), None),
    )
    .await
    .expect("the transcript read must not hang")
    .expect("the driver must answer the transcript read");

    /* 空会话的一页仍要是一页：形状不对的话 native-bridge 的 zod 会当场拒掉。 */
    assert_eq!(page.get("agent_id").and_then(|v| v.as_str()), Some("main"));
    assert_eq!(
        page.get("items").and_then(|v| v.as_array()).map(Vec::len),
        Some(0)
    );

    let caught = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        connection
            .client
            .catch_up_transcript(opened.session_id.clone(), "main".to_owned(), 0),
    )
    .await
    .expect("the transcript catch-up must not hang")
    .expect("the driver must answer the transcript catch-up");

    assert_eq!(
        caught.get("latest_seq").and_then(serde_json::Value::as_i64),
        Some(0)
    );
    assert_eq!(
        caught.get("complete").and_then(serde_json::Value::as_bool),
        Some(true)
    );

    /*
     * 模型目录：这条走的是「问桥要 agent 自己那份注册表」，证明目录不再由本机
     * 空答。目录内容随这台机器的 agent 配置而变，所以只断言它解得开、且每一格
     * 都有出处 —— 具体有几个 provider 不是本层的判据。
     */
    let catalog = connection
        .client
        .model_catalog(poietica_agent_client::ModelCatalogOperation::Snapshot)
        .await
        .expect("the model catalog must answer through the bridge");

    for model in &catalog.models {
        assert!(
            !model.provider.is_empty() && !model.model.is_empty(),
            "a catalog entry without a provider or an id cannot be picked"
        );
    }

    for provider in &catalog.providers {
        assert!(
            !provider.id.is_empty(),
            "a provider entry without an id cannot be addressed"
        );
    }

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
