#![allow(
    clippy::expect_used,
    clippy::unwrap_used,
    reason = "a test proves itself by panicking, so a failed step must fail the test"
)]
use std::path::PathBuf;

use poietica_agent_persistence_native::{AgentStore, RecordedFrame, SessionCursor};
use serde_json::value::RawValue;
use tempfile::TempDir;
use uuid::Uuid;

/*
 * 日志与读点的不变量。
 *
 * 这两样东西不需要界面、不需要进程、不需要 agent：AgentStore::open 一个入口就能
 * 摆出全部装置。撞位报不报、读点会不会被拉回去、一页读完从哪儿接着读 —— 症状都
 * 要到下一次打开对话时才看得见，所以它们必须在这里被钉住。
 */

fn database_path(directory: &TempDir) -> PathBuf {
    directory.path().join("ai.sqlite3")
}

fn frame(session: &str, seq: i64) -> RecordedFrame {
    RecordedFrame {
        session_id: session.to_owned(),
        seq,
        at: seq,
        frame: RawValue::from_string(format!(r#"{{"kind":"run_started","seq":{seq}}}"#))
            .expect("frame"),
    }
}

fn opened(directory: &TempDir) -> (AgentStore, Uuid) {
    let store = AgentStore::open(&database_path(directory)).expect("open");
    let thread = store
        .create_thread(Uuid::now_v7(), "thread", None)
        .expect("thread");

    store
        .attach_session(thread, "session-a", "kimi")
        .expect("attach");

    (store, thread)
}

/// 同一个位置只收一次，而且撞车要报出来。
#[test]
fn a_taken_position_is_refused_and_counted() {
    let directory = TempDir::new().expect("temporary directory");
    let (mut store, thread) = opened(&directory);

    assert_eq!(
        store
            .record_frames(thread, &[frame("session-a", 1)])
            .expect("append"),
        0
    );
    assert_eq!(
        store
            .record_frames(thread, &[frame("session-a", 1)])
            .expect("append"),
        1,
        "唯一键挡下的那一帧必须报出来 —— 咽下去要到下次打开这条对话才看得出少了帧"
    );

    let page = store.frames_before(thread, None, 10).expect("read");

    assert_eq!(page.frames.len(), 1, "撞车不许在表上留下第二行");
}

/// 一帧撞车不牵连同一批的其余帧。
#[test]
fn a_collision_does_not_take_the_rest_of_the_batch_down() {
    let directory = TempDir::new().expect("temporary directory");
    let (mut store, thread) = opened(&directory);

    store
        .record_frames(thread, &[frame("session-a", 1)])
        .expect("append");

    let refused = store
        .record_frames(thread, &[frame("session-a", 1), frame("session-a", 2)])
        .expect("append");

    assert_eq!(refused, 1);
    assert_eq!(
        store.last_seq(thread, "session-a").expect("seq"),
        2,
        "没撞上的那一帧照常落库，一批共用一次提交不等于一批共命运"
    );
}

/// 一页读完，下一页从这一页最早那一帧接着往前。
#[test]
fn a_page_hands_the_next_one_where_to_resume() {
    let directory = TempDir::new().expect("temporary directory");
    let (mut store, thread) = opened(&directory);

    store
        .record_frames(
            thread,
            &[
                frame("session-a", 1),
                frame("session-a", 2),
                frame("session-a", 3),
            ],
        )
        .expect("append");

    let latest = store.frames_before(thread, None, 2).expect("read");

    assert_eq!(latest.frames.len(), 2);

    let resume = latest.before.expect("读满一页就必须交出接着读的位置");

    assert_eq!(resume.seq, 2, "接着读的位置是这一页最早那一帧");

    let earlier = store.frames_before(thread, Some(&resume), 2).expect("read");

    assert_eq!(earlier.frames.len(), 1);
    assert!(earlier.before.is_none(), "没读满就是前面没有了");
}

/// 读点在同一纪元里只前进；纪元一换就整格重置。
#[test]
fn a_read_point_only_moves_forward_inside_one_epoch() {
    let directory = TempDir::new().expect("temporary directory");
    let (store, _thread) = opened(&directory);

    let ahead = SessionCursor {
        seq: 5,
        epoch: Some("epoch-a".to_owned()),
    };

    store
        .remember_cursor("session-a", &ahead)
        .expect("remember");
    store
        .remember_cursor(
            "session-a",
            &SessionCursor {
                seq: 3,
                epoch: Some("epoch-a".to_owned()),
            },
        )
        .expect("remember");

    assert_eq!(
        store.cursor_of("session-a").expect("read"),
        Some(ahead),
        "乱序到达的一帧不该把读点拉回去"
    );

    let next = SessionCursor {
        seq: 1,
        epoch: Some("epoch-b".to_owned()),
    };

    store.remember_cursor("session-a", &next).expect("remember");

    assert_eq!(
        store.cursor_of("session-a").expect("read"),
        Some(next),
        "新纪元的 seq 与旧纪元不在同一条流上，所以整格重置而不是取大"
    );

    store.forget_cursor("session-a").expect("forget");

    assert_eq!(store.cursor_of("session-a").expect("read"), None);
}
