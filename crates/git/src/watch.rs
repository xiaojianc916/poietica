//! 工作树变化的等待面。
//!
//! 监视交给 notify —— Windows 的 ReadDirectoryChangesW、macOS 的 FSEvents、
//! Linux 的 inotify 各自的边界情况已经在那个 crate 里解决过，轮询是错的范式。
//! .git 内部只认 HEAD：其余条目（对象库、日志、锁、index 刷新）改变不了变更面
//! 的结论，却会把 git 自己的写入反馈成新一轮通知。判据与 opencode 的
//! packages/core/src/filesystem/watcher.ts 一致。

use std::path::Path;
use std::time::Duration;

use notify::{EventKind, RecursiveMode, Watcher};
use tokio::sync::mpsc;

use crate::GitError;

/// 一次等待最多挂这么久。到点交回「没动」，由调用方决定还等不等 ——
/// 永不返回的等待会把监视句柄留在无人认领的地方。
const WINDOW: Duration = Duration::from_mins(1);

/// 合流窗口：一次保存是多条事件，一次切分支是上千条。
const QUIET: Duration = Duration::from_millis(300);

/// 等这个目录的下一次变化。true = 变了，false = 这一窗里没动。
///
/// 监视随这一次调用创建与销毁，所以没有跨调用存活的注册表。
pub async fn await_change(root: &Path) -> Result<bool, GitError> {
    let (sender, mut receiver) = mpsc::unbounded_channel::<()>();

    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else {
            return;
        };

        if matches!(event.kind, EventKind::Access(_)) {
            return;
        }

        if !event.paths.iter().any(|path| noteworthy(path)) {
            return;
        }

        let _ = sender.send(());
    })?;

    watcher.watch(root, RecursiveMode::Recursive)?;

    if !matches!(
        tokio::time::timeout(WINDOW, receiver.recv()).await,
        Ok(Some(()))
    ) {
        return Ok(false);
    }

    while matches!(
        tokio::time::timeout(QUIET, receiver.recv()).await,
        Ok(Some(()))
    ) {}

    Ok(true)
}

/// .git 里只有 HEAD 换过结论。
fn noteworthy(path: &Path) -> bool {
    let inside_git = path.components().any(|part| part.as_os_str() == ".git");

    !inside_git || path.file_name().is_some_and(|name| name == "HEAD")
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        reason = "测试面对的是已知夹具，假设破了就该大声失败"
    )]

    use std::path::Path;
    use std::time::Duration;

    use super::{await_change, noteworthy};

    #[test]
    fn git_internals_do_not_count_except_head() {
        assert!(noteworthy(Path::new("src/lib.rs")));
        assert!(noteworthy(Path::new(".git/HEAD")));
        assert!(!noteworthy(Path::new(".git/index")));
        assert!(!noteworthy(Path::new(".git/objects/ab/cdef")));
    }

    #[tokio::test]
    async fn a_written_file_ends_the_wait() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().to_owned();
        let waiting = tokio::spawn(async move { await_change(&root).await });

        tokio::time::sleep(Duration::from_millis(200)).await;
        tokio::fs::write(dir.path().join("one.txt"), b"hello")
            .await
            .expect("write");

        assert!(waiting.await.expect("join").expect("await_change"));
    }
}
