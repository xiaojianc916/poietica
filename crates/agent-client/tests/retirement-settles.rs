//! 收摊不许吞掉**已经受理、还没应答**的请求。
//!
//! 这条不变量是「首启一次 agent 连接失败」的另一半根因：换工作区的一方（`Replace`）
//! 会把旧连接退休，而退休会把应答槽一起丢掉 —— 挂在旧连接上那趟还在飞的读，拿到的是
//! `Err(_dropped)` → `Refused(Gone)`。它并没有失败，它只是还没轮到。
//!
//! 判据：一条命令发出去、桥还没来得及应答时取消连接，调用方拿到的必须是**答复**，
//! 不是 `Gone`。修好之前这里必然拿到 `Gone`（驱动器当场 return，`pending` 随栈消失）。

#![allow(
    clippy::expect_used,
    clippy::panic,
    reason = "a regression test proves itself by panicking on an unexpected error"
)]

use std::path::PathBuf;

use poietica_agent_client::{
    AgentError, AgentSpawn, PermissionDesk, ProcessEnvironment, QuestionDesk, Refusal, RunSlot,
    connect,
};

fn bundled() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/resources/agent")
}

fn home() -> PathBuf {
    let directory =
        std::env::temp_dir().join(format!("poietica-settle-test-{}", std::process::id()));
    let _created = std::fs::create_dir_all(&directory);
    directory
}

#[tokio::test]
async fn a_retired_connection_answers_what_it_already_accepted() {
    let bundled = bundled();

    if !bundled.join("poietica-bridge.js").is_file() {
        return;
    }

    let connection = connect(
        AgentSpawn {
            program: "bun".to_owned(),
            bundled,
            entry: "poietica-bridge.js".to_owned(),
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
    )
    .expect("the agent connection must be constructible");

    let stop = connection.stop.clone();
    let client = connection.client.clone();
    let driver = tokio::spawn(connection.driver);

    let handshake = tokio::time::timeout(std::time::Duration::from_secs(120), connection.handshake)
        .await
        .expect("the handshake must not hang")
        .expect("the driver must answer the handshake")
        .expect("the bundled agent must open a session");

    /*
     * 发一条要过桥的命令，然后**立刻**取消连接：这正是「换锚」那一刻的形状
     * （`previous.retire()` 与 retire 之前的那次 `cancel()` 是同一件事）。
     *
     * 不断言它一定还在飞 —— 桥快的时候它可能已经答完了，那也是合法结局。判据是：
     * 无论哪种，都不许是「没接上」（`Refusal::Gone`）。
     */
    let pending = client
        .selectors(handshake.session_id.clone())
        .expect("the command must be sendable");

    stop.cancel();

    let answer = tokio::time::timeout(std::time::Duration::from_secs(30), pending)
        .await
        .expect("a cancelled connection must still settle its accepted work");

    /*
     * 判据：**给得起答复**。两种被吞掉都要当场失败 ——
     *   外层 `Canceled`：应答复槽整个被丢；
     *   内层 `Refused(Gone)`：命令自己的应答槽随连接没了。
     * 后者正是屏幕上那次「agent 连接失败」。
     */
    let answer = answer.expect("the retired connection must not drop an accepted request's slot");

    match answer {
        Ok(_offered) => {}
        Err(AgentError::Refused(Refusal::Gone)) => {
            panic!("the retired connection swallowed a request it had already accepted");
        }
        Err(other) => panic!("unexpected failure for an accepted request: {other:?}"),
    }

    /* 驱动器必须自己收摊，不能永远挂着。 */
    tokio::time::timeout(std::time::Duration::from_secs(30), driver)
        .await
        .expect("the driver must finish retiring")
        .expect("the driver must not panic")
        .expect("the driver must retire cleanly");
}
