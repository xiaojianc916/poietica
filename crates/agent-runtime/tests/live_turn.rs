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
//! cargo test -p poietica-agent-runtime-native --test live_turn -- --ignored --nocapture
//! ```
//!
//! `#[ignore]` 说的是不跑，不是不编。这个文件照样由 `pnpm clippy`
//! （`--all-targets`）和 `pnpm test:rust` 编译，而它是产品代码之外唯一调用
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
//! - `POIETICA_KAP_TIMEOUT`  seconds before the turn is cancelled (default: 120)
//! - `POIETICA_KAP_CAPTURE` a path to write the recorded frames to, so the
//!   renderer's schema can be tested against frames a real agent actually sent
//! - `POIETICA_KAP_EXPECT`  frame kinds and session update discriminators the
//!   turn must contain, comma separated, checked before anything is captured,
//!   and required whenever a capture is requested
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
use poietica_agent_runtime_native::{
    AgentConnection, AgentSpawn, KapError, PermissionDesk, RUN_FINISHED, RUN_STARTED,
    RecordedEvent, RunFrame, RunSlot, connect_kap,
};
use tempfile::TempDir;

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

    /* 程序与参数分开给，和产品代码走的是同一条路：这个测试存在的意义就是证明
    真进程起得来，如果它自己先把两者拼成一行，那它证明的就是另一条管线了。 */
    let spawn = AgentSpawn {
        program: setting("POIETICA_KAP_PROGRAM", DEFAULT_PROGRAM),
        args: setting("POIETICA_KAP_ARGS", DEFAULT_ARGS)
            .split_whitespace()
            .map(str::to_owned)
            .collect(),
        cwd,
        // 受控 home 是桌面组合层的产品决策，这一层只起进程，不替它做决定。
        env: Vec::new(),
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

    /* 会话级状态那一路不接。它的终点在桌面组合层（那里把它变成界面事件），
    而这个测试证明的是驱动器自己走得通一轮。接收端在这里被丢掉，驱动器那侧的
    发送随之失败并被忽略，这一轮不受影响。 */
    let AgentConnection {
        client,
        book: _,
        events: _,
        handshake,
        driver,
    } = connect_kap(spawn, slot, desk).expect("the program to be launchable");

    let mut driver = Driver::spawn(driver);

    /* 握手自己带着原因回来。此前这一格是一个只送会话号的通道，失败唯一的表示
    就是发送端被丢掉 —— 于是「agent 要求先登录」在这里也只报成一句「通道断了」，
    而这个测试正是最需要那个原因的地方。 */
    let handshake = driver
        .expect(handshake, "the agent never finished the handshake")
        .expect("the handshake to succeed");

    /* 三张凭证只有真 agent 发得出来，所以只有在这里观察得到。它们决定了
    「点开旧对话」「删除对话」「分叉对话」各自走哪条路。 */
    println!(
        "session: {} (load: {}, delete: {}, fork: {})",
        handshake.session_id,
        handshake.loading.is_some(),
        handshake.deleting.is_some(),
        handshake.forking.is_some()
    );

    let session_id = handshake.session_id;

    // Nobody is here to answer a permission request, and an agent that asks one
    // would otherwise wait forever. Cancelling is both the escape and a free
    // exercise of the cancellation path.
    let watchdog = client.clone();
    let watched = session_id.clone();
    let cancelling = handshake.cancelling;
    let _timer = thread::spawn(move || {
        thread::sleep(timeout);
        let _ignored = match cancelling {
            Some(granted) => watchdog.cancel(granted, watched),
            None => Ok(()),
        };
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
    print!("{}", outline(&broadcast));

    report(&broadcast);

    /* 关机排在断言之前：断言失败也要把 server 带走，否则每失败一次就在这台机器
    上留一个 kimi。 */
    client.shutdown().expect("the session to close");

    driver.finish();

    let first = broadcast.first().expect("at least one frame");
    let last = broadcast.last().expect("at least one frame");

    assert_eq!(
        first.frame.kind(),
        RUN_STARTED,
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

    /* 录制之前，不是之后：一轮没抓到它要抓的东西，就不能覆盖掉抓到了的那份
    录音 —— 一轮以失败收场同样不行。 */
    require_expected(&broadcast);

    capture(&broadcast);

    println!("recorded {} frames", broadcast.len());
}

/// Everything the turn actually contained.
///
/// A frame counts under its log kind, and a session update counts under its
/// protocol discriminator as well, because that is the level the timeline
/// renders at and therefore the level a fixture is judged at.
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

/// What this turn is worth as a fixture.
fn report(events: &[RecordedEvent]) {
    println!("contains:");

    for (marker, count) in markers(events) {
        println!("  {count:>3}  {marker}");
    }
}

/// Fails when the turn is missing something it was recorded to capture.
///
/// The agent decides what to do, so a prompt that merely invites a tool call
/// is often answered from memory. Without this the run still passes, the
/// capture is still written, and the gap only surfaces much later as a
/// renderer tested against frames no agent ever sent.
fn require_expected(events: &[RecordedEvent]) {
    let present = markers(events);
    let wanted = setting("POIETICA_KAP_EXPECT", "");

    /* A capture overwrites the fixture other tests are judged against, and an
    exported variable outlives the run that needed it, so a capture path
    left in the shell is enough to replace a good recording with whatever
    the next turn happened to be. Asking what the recording is for costs one
    line and makes that impossible. */
    assert!(
        setting("POIETICA_KAP_CAPTURE", "").is_empty() || !wanted.is_empty(),
        "POIETICA_KAP_CAPTURE would replace a fixture, so POIETICA_KAP_EXPECT must say what this recording is for"
    );

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
        RunFrame::RunStarted { prompt, .. } => prompt.clone(),
        RunFrame::KapEvent { payload } => match describe(frame).as_str() {
            // 增量一帧一个字，摊开来只会把名单淹掉。
            "assistant.delta" | "thinking.delta" | "tool.call.delta" => String::new(),
            _ => payload.to_string(),
        },
        RunFrame::PermissionRequested { title, .. } => title.clone(),
        RunFrame::PermissionResolved { outcome, .. } => outcome.clone(),
        RunFrame::RunFinished { stop_reason } => stop_reason.clone(),
        RunFrame::RunFailed { message } => message.clone(),
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
                "  {:>3} {:<12} {:<22} {}\n",
                event.seq,
                event.frame.kind(),
                describe(&event.frame),
                detail(&event.frame)
            )
        })
        .collect()
}

/// Writes the turn out, when asked.
///
/// The renderer validates every frame before it reaches the timeline, and that
/// validator has only ever been tested against frames written by hand. A
/// recording of a real turn is the only honest input for it, so this makes one
/// on request rather than inventing one.
///
/// It is written as a TypeScript module rather than as data, because the
/// package that reads it is a browser package with no filesystem and no Node
/// types. A module is imported by the same rules as any other source file,
/// which keeps a test fixture from dragging a platform into a layer that had
/// deliberately stayed out of one.
fn capture(events: &[RecordedEvent]) {
    let Ok(path) = env::var("POIETICA_KAP_CAPTURE") else {
        return;
    };

    if path.trim().is_empty() {
        return;
    }

    let path = PathBuf::from(path);

    /* The recording is source code, so it has to be named like source code. A
    path with any other extension would be written all the same, and the test
    that imports the module would go on reporting that it does not exist,
    which is a long way to travel to learn that a variable was stale. */
    assert!(
        path.extension().is_some_and(|extension| extension == "ts"),
        "POIETICA_KAP_CAPTURE must name a .ts module; got {}",
        path.display()
    );

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("the capture directory");
    }

    let body = serde_json::to_string_pretty(events).expect("the frames to serialise");

    let module = format!(
        "// Generated by crates/agent-runtime/tests/live_turn.rs. Do not edit.\n\
         //\n\
         // One real turn, recorded verbatim. If a frame here fails validation the\n\
         // validator is wrong, not the recording. Regenerate with:\n\
         //\n\
         //   cargo test -p poietica-agent-runtime-native --test live_turn -- --ignored\n\
         \n\
         export interface RecordedFrame {{\n\
         \u{20}\u{20}readonly sessionId: string\n\
         \u{20}\u{20}readonly seq: number\n\
         \u{20}\u{20}readonly at: number\n\
         \u{20}\u{20}readonly kind: string\n\
         \u{20}\u{20}readonly [field: string]: unknown\n\
         }}\n\
         \n\
         export const recordedTurn: readonly RecordedFrame[] = {body}\n"
    );

    std::fs::write(&path, module).expect("the capture to be written");

    println!("captured {} frames to {}", events.len(), path.display());
}
