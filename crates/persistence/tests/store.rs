#![allow(
    clippy::expect_used,
    clippy::unwrap_used,
    reason = "a test proves itself by panicking, so a failed step must fail the test"
)]
use std::path::PathBuf;

use poietica_agent_persistence_native::AgentStore;
use tempfile::TempDir;
use uuid::Uuid;

fn database_path(directory: &TempDir) -> PathBuf {
    directory.path().join("ai.sqlite3")
}

#[test]
fn a_conversation_is_listed_once_someone_has_spoken_in_it() {
    let directory = TempDir::new().expect("temporary directory");
    let store = AgentStore::open(&database_path(&directory)).expect("open");

    let quiet = store
        .create_thread(Uuid::now_v7(), "新建对话", None)
        .expect("thread");
    let spoken = store
        .create_thread(Uuid::now_v7(), "新建对话", None)
        .expect("thread");

    store
        .record_prompt(spoken, "帮我看看这段代码")
        .expect("name");

    let listed = store.list_threads().expect("list");
    let ids: Vec<String> = listed.into_iter().map(|thread| thread.id).collect();

    assert_eq!(
        ids,
        vec![spoken.to_string()],
        "名字来自第一句话，所以还挂着占位名的那条还没有人开口"
    );
    assert!(!ids.contains(&quiet.to_string()));
}

/// 说第二句话：位置要动，名字不能动。
///
/// 这条 bug 当初能安然通过全部测试，是因为上面那条只问了「开过口的有没有进
/// 列表」—— 而它在第一句话之后就不再有话说。名字取自第一句、活动时间跟着每
/// 一句，是两个不同频率的事实，所以要各钉各的。
///
/// 时间戳带亚秒（`now()` 走的是 RFC 3339 的 `OffsetDateTime::now_utc`），两次
/// 连续写入必然不等，所以这里可以直接断严格不等，不必让测试去睡。
#[test]
fn speaking_again_moves_a_conversation_up_without_renaming_it() {
    let directory = TempDir::new().expect("temporary directory");
    let store = AgentStore::open(&database_path(&directory)).expect("open");

    let earlier = store
        .create_thread(Uuid::now_v7(), "新建对话", None)
        .expect("thread");
    let later = store
        .create_thread(Uuid::now_v7(), "新建对话", None)
        .expect("thread");

    store
        .record_prompt(earlier, "第一句")
        .expect("opening line");
    store
        .record_prompt(later, "另一条对话")
        .expect("opening line");

    let before = store.thread(earlier).expect("read").expect("the thread");

    store
        .record_prompt(earlier, "第二句")
        .expect("a later turn");

    let after = store.thread(earlier).expect("read").expect("the thread");

    assert_eq!(
        after.title, "第一句",
        "名字取自第一句话，后一轮的开场白改不动一条已经有名字的对话"
    );
    assert!(
        after.updated_at > before.updated_at,
        "说话就是活动，而列表按活动排序，所以这一格必须跟上"
    );

    let listed = store.list_threads().expect("list");
    let ids: Vec<String> = listed.into_iter().map(|thread| thread.id).collect();

    assert_eq!(
        ids.first(),
        Some(&earlier.to_string()),
        "刚说过话的那条排在最前，哪怕它是先建的"
    );
    assert!(ids.contains(&later.to_string()));
}

#[test]
fn a_session_is_stored_with_the_agent_that_opened_it() {
    let directory = TempDir::new().expect("temporary directory");
    let store = AgentStore::open(&database_path(&directory)).expect("open");

    let thread = store
        .create_thread(Uuid::now_v7(), "thread", None)
        .expect("thread");

    store
        .attach_session(thread, "session-a", "kimi")
        .expect("attach");

    let read = store.thread(thread).expect("read").expect("the thread");

    assert_eq!(read.session_id.as_deref(), Some("session-a"));
    assert_eq!(
        read.agent_id.as_deref(),
        Some("kimi"),
        "会话号只在开出它的 agent 那里认得，所以持有者必须跟着一起存下来"
    );
}

#[test]
fn a_thread_holding_no_session_has_no_owner() {
    let directory = TempDir::new().expect("temporary directory");
    let store = AgentStore::open(&database_path(&directory)).expect("open");

    let thread = store
        .create_thread(Uuid::now_v7(), "thread", None)
        .expect("thread");
    let read = store.thread(thread).expect("read").expect("the thread");

    assert_eq!(
        read.agent_id, None,
        "空值只有一个意思：这条对话还没有握住会话"
    );
}

/// 有号无主的行进不了库 —— 而且不是靠调用方自觉。
///
/// attach_session 两列一起写，所以走公开接口根本造不出这种行；这条测试要证的
/// 是「就算绕过它也造不出来」，因为下一刀要按这条不变量去选连接。所以这里
/// 直接开同一个库文件写原始 SQL：库自己拦，才叫库保证。
#[test]
fn a_session_without_an_owner_is_refused_by_the_database() {
    let directory = TempDir::new().expect("temporary directory");
    let path = database_path(&directory);

    let store = AgentStore::open(&path).expect("open");
    let thread = store
        .create_thread(Uuid::now_v7(), "thread", None)
        .expect("thread");
    drop(store);

    let raw = rusqlite::Connection::open(&path).expect("open the same file");
    let written = raw.execute(
        "UPDATE threads SET session_id = 'session-a' WHERE id = ?1",
        rusqlite::params![thread.to_string()],
    );

    assert!(
        written.is_err(),
        "会话号只在开出它的 agent 那里认得，所以库里不许有一行握着号却说不出主人"
    );
}

/// 对话记得它是在哪个目录里开的。
///
/// 两条读路径各有一份 SELECT（`thread` 与 `list_threads`），所以两条都要问：
/// 只给一份加上这一列，症状是「侧栏分组对了，而打开那条对话又跑回默认目录」，
/// 那是最难查的一类不一致。
///
/// 空不是「不知道」，是「默认那一个工作区」：不带目录开出的对话就在它里面。
/// 这条测试把这个含义钉住，否则总会有人来加一段回填。
#[test]
fn a_conversation_remembers_the_directory_it_was_opened_in() {
    const PROJECT: &str = "D:/com.xiaojianc/my_desktop_app";

    let directory = TempDir::new().expect("temporary directory");
    let store = AgentStore::open(&database_path(&directory)).expect("open");

    let here = store
        .create_thread(Uuid::now_v7(), "新建对话", Some(PROJECT))
        .expect("thread");
    let anywhere = store
        .create_thread(Uuid::now_v7(), "新建对话", None)
        .expect("thread");

    store.record_prompt(here, "这个项目").expect("opening line");
    store
        .record_prompt(anywhere, "另一处")
        .expect("opening line");

    let read = store.thread(here).expect("read").expect("the thread");

    assert_eq!(
        read.workspace_root.as_deref(),
        Some(PROJECT),
        "会话开在哪个目录里，是这条对话自己的属性"
    );

    let listed = store.list_threads().expect("list");

    assert!(
        listed
            .iter()
            .any(|thread| thread.workspace_root.as_deref() == Some(PROJECT)),
        "整表那一条 SELECT 也要带上这一列，否则侧栏无从分组"
    );
    assert!(
        listed.iter().any(|thread| thread.workspace_root.is_none()),
        "空的含义是默认那一个工作区"
    );
}
