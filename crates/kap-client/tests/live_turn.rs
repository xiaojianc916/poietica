#![allow(
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::panic,
    reason = "a test proves itself by panicking, so a failed step must fail the test"
)]
#![allow(
    clippy::print_stdout,
    reason = "this turn is driven by hand against a real agent, and its printout is"
)]
#![allow(
    clippy::similar_names,
    reason = "the recorder writes the run, and the recorded frames are read back"
)]
//! One real turn against a real agent process.
//!
//! Everything else in this crate is tested without a process, which proves the
//! recording and the projections but proves nothing about the driver: the
//! handshake, the session, the notification stream and the cancellation path
//! have never been exercised against an agent that actually exists.
//!
//! This test does that, and it is ignored by default because it spawns a
//! program, talks to a model and costs money and time. Run it deliberately:
//!
//! ```text
//! cargo test -p poietica-kap-client --test live_turn -- --ignored --nocapture
//! ```
//!
//! `#[ignore]` 说的是不跑，不是不编。这个文件照样由 `bun run clippy`
//! （`--all-targets`）和 `bun run test:rust` 编译，而它是产品代码之外唯一调用
//! `AgentClient::prompt` 的地方 —— 改那个签名就必须改到这里，改漏了在提交前
//! 就会被拦住。
//!
//! It is configured by the environment rather than by anything committed here,
//! so no machine's paths end up in the repository:
//!
//! - `POIETICA_KAP_PROGRAM`  the agent executable (default: `kimi`)
//! - `POIETICA_KAP_ARGS`     its arguments, space separated (default: `web --no-open`)
//! - `POIETICA_KAP_PROMPT`   what to ask (default: a one-word reply)
//! - `POIETICA_KAP_CWD`      the session's working directory (default: a temporary one)
//! - `POIETICA_KAP_HOME`     the agent's data home, where the registry and
//!   server.token live (default: `~/.kimi-code`)
//! - `POIETICA_KAP_TIMEOUT`  seconds before the turn is cancelled (default: 120)
//! - `POIETICA_KAP_MODEL`    the model to run this turn on, named the way the
//!   agent names it in its `model` selector, which this test prints (default:
//!   whatever the session is bound to, i.e. this machine's default model)
//! - `POIETICA_KAP_EXPECT`  frame kinds and session update discriminators the
//!   turn must contain, comma separated
//!
//! Every wait in here is two-sided. The channels the client hands back are
//! cancelled when the connection dies, and a cancelled channel says nothing
//! about why, so each wait that comes back empty asks the driver thread for the
//! actual failure before reporting anything.

mod frame_sink;

use std::collections::BTreeMap;
use std::env;
use std::path::PathBuf;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use futures::channel::oneshot;
use futures::executor::block_on;
use poietica_kap_client::{
    AgentConnection, AgentSpawn, ConfigControl, KapError, PROMPT_ADMITTED, PermissionDesk,
    QuestionDesk, RUN_FINISHED, RecordedEvent, RunFrame, RunSlot, connect,
};
use tempfile::TempDir;
use uuid::Uuid;

use frame_sink::Delivered;

const DEFAULT_PROGRAM: &str = "kimi";
const DEFAULT_ARGS: &str = "web --no-open";
const DEFAULT_PROMPT: &str = "Reply with the single word: ready. Do not use any tools.";
const DEFAULT_TIMEOUT_SECONDS: u64 = 120;

/// What to check first when the process never came up.
const SPAWN_HINT: &str = "the agent process did not come up. check that the program runs on \
its own in a terminal. the executable is resolved with the which crate, so a bare name is \
enough even on Windows and kimi.cmd no longer has to be spelled out. override it with \
POIETICA_KAP_PROGRAM rather than editing this test";

fn setting(name: &str, fallback: &str) -> String {
    env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| fallback.to_owned())
}

/// The driver, and the reason it stopped.
///
/// The connection owns every channel this test waits on, so when it dies the
/// waits all fail identically and uselessly. This is where the useful answer
/// lives.
struct Driver(Option<JoinHandle<Result<(), KapError>>>);

impl Driver {
    fn spawn(driver: impl Future<Output = Result<(), KapError>> + Send + 'static) -> Self {
        // kap 的 driver 要 tokio reactor（process / fs / time / select!）。这个
        // crate 不替它选 runtime：src-tauri 用 tauri 的 async_runtime，测试在
        // 自己的驱动线程上起一个 current_thread runtime —— 同一条规矩。
        Self(Some(thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("a tokio runtime");

            runtime.block_on(driver)
        })))
    }

    /// Why the connection is gone, in the driver's own words.
    fn reason(&mut self) -> String {
        match self.0.take() {
            None => "the driver had already been joined".to_owned(),
            Some(handle) => match handle.join() {
                Ok(Ok(())) => "the connection closed without reporting a failure".to_owned(),
                Ok(Err(error)) => error.to_string(),
                Err(_panicked) => "the driver thread panicked".to_owned(),
            },
        }
    }

    /// Waits for an answer, or explains the silence.
    fn expect<T>(&mut self, waiting: oneshot::Receiver<T>, what: &str) -> T {
        match block_on(waiting) {
            Ok(value) => value,
            Err(_cancelled) => {
                let reason = self.reason();

                panic!("{what}: {reason}\n\nhint: {SPAWN_HINT}")
            }
        }
    }

    fn finish(&mut self) {
        let reason = self.reason();

        assert_eq!(
            reason, "the connection closed without reporting a failure",
            "the session must end cleanly"
        );
    }
}

#[test]
#[ignore = "spawns a real agent process; run with --ignored"]
fn a_real_turn_is_recorded_exactly_as_it_is_broadcast() {
    let directory = TempDir::new().expect("a temporary directory");

    /*
     * 这一层不写任何存储，所以这个测试也不建数据库。它要证明的是驱动器：握手、
     * 会话、通知流、取消 —— 那些没有真进程就永远走不到的路径。
     */
    let cwd = env::var("POIETICA_KAP_CWD")
        .map_or_else(|_unset| directory.path().to_path_buf(), PathBuf::from);

    // agent 的家：driver 在它下面找实例注册表与 server.token。默认 kimi-code
    // 自己的默认 home（那里有登录态），可用 POIETICA_KAP_HOME 覆盖。
    let home = env::var("POIETICA_KAP_HOME").map_or_else(
        |_unset| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".kimi-code")
        },
        PathBuf::from,
    );

    /* 程序与参数分开给，和产品代码走的是同一条路：这个测试存在的意义就是证明
    真进程起得来，如果它自己先把两者拼成一行，那它证明的就是另一条管线了。 */
    let spawn = AgentSpawn {
        program: setting("POIETICA_KAP_PROGRAM", DEFAULT_PROGRAM),
        args: setting("POIETICA_KAP_ARGS", DEFAULT_ARGS)
            .split_whitespace()
            .map(str::to_owned)
            .collect(),
        cwd,
        env: Vec::new(),
        home,
    };

    let timeout = Duration::from_secs(
        setting("POIETICA_KAP_TIMEOUT", "")
            .parse::<u64>()
            .unwrap_or(DEFAULT_TIMEOUT_SECONDS),
    );

    println!(
        "starting: {} {:?} in {}",
        spawn.program,
        spawn.args,
        spawn.cwd.display()
    );

    let slot = RunSlot::new();
    let desk = PermissionDesk::new();
    let questions = QuestionDesk::new();

    /* 会话级状态那一路不接。它的终点在桌面组合层（那里把它变成界面事件），
    而这个测试证明的是驱动器自己走得通一轮。接收端在这里被丢掉，驱动器那侧的
    发送随之失败并被忽略，这一轮不受影响。 */
    let AgentConnection {
        client,
        book: _,
        events: _,
        handshake,
        driver,
    } = connect(spawn, slot, desk, questions).expect("the program to be launchable");

    let mut driver = Driver::spawn(driver);

    /* 握手自己带着原因回来。此前这一格是一个只送会话号的通道，失败唯一的表示
    就是发送端被丢掉 —— 于是「agent 要求先登录」在这里也只报成一句「通道断了」，
    而这个测试正是最需要那个原因的地方。 */
    let handshake = driver
        .expect(handshake, "the agent never finished the handshake")
        .expect("the handshake to succeed");

    let session_id = handshake.session_id;

    println!("session: {session_id}");

    /* 这一轮跑在什么配置上。模型不是背景信息：kap 的新会话天生没有模型，绑上
    它是开会话这一方的活，绑没绑上决定了这一轮能不能开口。选择器读不出来不
    终止这个测试 —— 那是另一件事，让它自己在名单上说。 */
    let offered = driver.expect(
        client
            .selectors(session_id.clone())
            .expect("the driver to accept the question"),
        "the selectors were never answered",
    );

    match offered {
        Ok(controls) => show(&controls),
        Err(error) => println!("selectors: unreadable ({error})"),
    }

    /* 换一个模型跑。默认模型未必是要证的那一个，也未必还有额度 —— 上一次
    实时验证就停在「账号欠费」上，而那与这一层的对错无关。没有这个开关，这个
    测试就被机器的全局默认锁死，改它等于拿产品配置迁就一个测试。

    走的是产品自己那条路（Command::Select → POST /sessions/{id}/profile），
    所以它同时证明了界面上那个下拉菜单换得动模型。换不动就地停：接着跑，跑的
    是旧模型，报回来的会是一条与请求无关的错误消息。 */
    let wanted = setting("POIETICA_KAP_MODEL", "");

    if !wanted.is_empty() {
        let switched = driver.expect(
            client
                .select(session_id.clone(), "model".to_owned(), wanted.clone(), None)
                .expect("the driver to accept the change"),
            "the model change was never answered",
        );

        match switched {
            Ok(controls) => show(&controls),
            Err(error) => panic!("the agent would not switch to {wanted}: {error}"),
        }
    }

    // Nobody is here to answer a permission request, and an agent that asks one
    // would otherwise wait forever. Cancelling is both the escape and a free
    // exercise of the cancellation path.
    let watchdog = client.clone();
    let watched = session_id.clone();
    let _timer = thread::spawn(move || {
        thread::sleep(timeout);
        let _ignored = watchdog.cancel(watched);
    });

    let delivered = Delivered::default();
    let frames = delivered.sink();

    let started = Instant::now();

    /* 一句话的三半：发给哪条会话、说了什么、带了哪些图。这一轮不带图，所以
    那一格是空的 —— 空是这一轮的事实，不是一个可以省略的参数。 */
    let answer = client
        .prompt(
            session_id.clone(),
            setting("POIETICA_KAP_PROMPT", DEFAULT_PROMPT),
            Vec::new(),
            Vec::new(),
            Uuid::new_v4().to_string(),
            frames,
        )
        .expect("the driver to accept the prompt");

    /* kap 的 prompt 是「受理即返回」：拿到的是 server 给的 prompt_id，回合
     * 此刻才刚开始跑。等它自己收尾 —— 广播里出现 run_finished —— 再关机，
     * 否则关掉的正是这个测试要观察的那一轮。 */
    let prompt_id = driver
        .expect(answer, "the prompt was never answered")
        .expect("the server to accept the prompt");

    println!("prompt: {prompt_id} after {:?}", started.elapsed());

    // 看门狗到点会取消这一轮，所以超过 timeout 还没收尾就是 driver 卡死了；
    // 多给的 30 秒是收尾本身的余量。
    let deadline = started + timeout + Duration::from_secs(30);

    /* 收尾有两种说法：agent 自己说完（run_finished），或者这一轮以失败告终
    （run_failed）。两种都是「这一轮结束了」，等就该等到这里为止。只认前一种，
    一个失败的回合就要把看门狗的 150 秒走完，再报一句与事实相反的「从没结束」，
    而结束的那一帧就摆在名单的最后一行。 */
    while !delivered.frames().iter().any(|event| {
        matches!(
            event.frame,
            RunFrame::RunFinished { .. } | RunFrame::RunFailed { .. }
        )
    }) {
        assert!(
            Instant::now() < deadline,
            "the turn never ended; recorded so far:\n{}",
            outline(&delivered.frames())
        );

        thread::sleep(Duration::from_millis(50));
    }

    println!("finished after {:?}", started.elapsed());

    let broadcast = delivered.frames();

    /* 先摆出这一轮，再判它对不对：断言 panic 之后什么都不会再打印，而一个失败
    的回合最需要的恰恰是这份名单。 */
    println!("{}", outline(&broadcast));

    report(&broadcast);

    /* 关机排在断言之前：断言失败也要把 server 带走，否则每失败一次就在这台机器
    上留一个 kimi。 */
    client.shutdown().expect("the session to close");

    driver.finish();

    let first = broadcast.first().expect("at least one frame");
    let last = broadcast.last().expect("at least one frame");

    assert_eq!(
        first.frame.kind(),
        PROMPT_ADMITTED,
        "a run announces itself first"
    );
    assert_eq!(
        last.frame.kind(),
        RUN_FINISHED,
        "the turn must end on the agent's terms, not in a client failure: {}",
        detail(&last.frame)
    );

    // 序号必须致密：位置在投递成功时才算用掉，所以一轮里不该出现空号。
    for (position, sent) in broadcast.iter().enumerate() {
        let expected = i64::try_from(position + 1).expect("a small sequence number");

        assert_eq!(sent.seq, expected, "sequence numbers are dense");
    }

    require_expected(&broadcast);

    println!("recorded {} frames", broadcast.len());
}

/// 这条会话此刻的选择，连同它给的候选。
///
/// 候选值得一并打出来：换一个模型是这个测试绕开「当前模型不能用」的唯一办法，
/// 而名单只有 agent 说了算 —— 猜一个名字换过去，换回来的是另一条错误消息。
///
/// 换之前与换之后打的是同一段。两处各写一遍，出事时看到的总是没人维护的那一份。
fn show(controls: &[ConfigControl]) {
    if controls.is_empty() {
        println!("selectors: none offered");

        return;
    }

    for control in controls {
        let choices = control
            .choices
            .iter()
            .map(|choice| choice.value.as_str())
            .collect::<Vec<&str>>()
            .join(", ");

        println!(
            "selector: {} = {} (of: {choices})",
            control.id, control.current
        );
    }
}

/// Everything the turn actually contained.
///
/// A frame counts under its log kind, and a session update counts under its
/// protocol discriminator as well, because that is the level
/// POIETICA_KAP_EXPECT names them at.
fn markers(events: &[RecordedEvent]) -> BTreeMap<String, usize> {
    let mut counted: BTreeMap<String, usize> = BTreeMap::new();

    for event in events {
        *counted.entry(event.frame.kind().to_owned()).or_default() += 1;

        let discriminator = describe(&event.frame);

        if !discriminator.is_empty() {
            *counted.entry(discriminator).or_default() += 1;
        }
    }

    counted
}

/// What this turn contained, for choosing POIETICA_KAP_EXPECT markers.
fn report(events: &[RecordedEvent]) {
    println!("contains:");

    for (marker, count) in markers(events) {
        println!("  {count:>3}  {marker}");
    }
}

/// Fails when the turn is missing a marker POIETICA_KAP_EXPECT asked for.
///
/// The agent decides what to do, so a prompt that merely invites a tool call
/// is often answered from memory, and the run would otherwise pass while
/// proving nothing about the path it was told to exercise.
fn require_expected(events: &[RecordedEvent]) {
    let present = markers(events);
    let wanted = setting("POIETICA_KAP_EXPECT", "");

    let missing = wanted
        .split(',')
        .map(str::trim)
        .filter(|marker| !marker.is_empty())
        .filter(|marker| !present.contains_key(*marker))
        .collect::<Vec<&str>>()
        .join(", ");

    assert!(
        missing.is_empty(),
        "the turn never contained: {missing}. ask for something the agent cannot know without acting, such as the contents of a named file inside POIETICA_KAP_CWD"
    );
}

/// What kind of update a frame carries.
///
/// A run of twenty identical kap_event lines says nothing. The interesting
/// part is kap 自己的事件类型，因为那些正是 timeline 要渲染的东西。
fn describe(frame: &RunFrame) -> String {
    let RunFrame::KapEvent { payload } = frame else {
        return String::new();
    };

    payload
        .get("type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_owned()
}

/// 这一帧自己的说法。
///
/// describe 给的是判别式 —— 夹具与 POIETICA_KAP_EXPECT 就判在那一层，所以它
/// 只能是判别式。人要看的是另一件事：失败的那句话、结束的那个理由、出错事件
/// 带的码。两者分开，看一眼原因才不至于顺手把 EXPECT 的词汇表改掉。
fn detail(frame: &RunFrame) -> String {
    match frame {
        RunFrame::PromptAdmitted { prompt, .. } => prompt.clone(),
        RunFrame::KapEvent { payload } => match describe(frame).as_str() {
            // 增量一帧一个字，摊开来只会把名单淹掉。
            "assistant.delta" | "thinking.delta" | "tool.call.delta" => String::new(),
            _ => payload.to_string(),
        },
        RunFrame::PermissionRequested { title, .. } => title.clone(),
        RunFrame::PermissionResolved {
            request_id: _,
            decision: _,
            scope: _,
        } => {
            panic!("PermissionResolved carries no payload, unreachable test branch")
        }
        RunFrame::QuestionsAsked { questions, .. } => questions.to_string(),
        RunFrame::QuestionsResolved {
            outcome,
            answers,
            note,
            ..
        } => {
            format!("outcome={outcome} answers={answers} note={note}")
        }
        RunFrame::RunFinished { stop_reason } => stop_reason.clone(),
        RunFrame::RunFailed { message } => message.clone(),
        RunFrame::LinkChanged { link } => serde_json::to_string(link).expect("link serializes"),
    }
}

/// 这一轮到此为止的样子，一帧一行。
///
/// 失败时看得到的只有这一段，所以渲染只此一处：跑通那条路打印的也是它，不另
/// 写第二个格式 —— 否则出事时看到的永远是没人维护的那一份。
fn outline(events: &[RecordedEvent]) -> String {
    events
        .iter()
        .map(|event| {
            format!(
                "  {:>3} {:<12} {:<22} {}",
                event.seq,
                event.frame.kind(),
                describe(&event.frame),
                detail(&event.frame)
            )
        })
        .collect::<Vec<String>>()
        .join("\n")
}
