//! 分支状态的唯一真相是磁盘上的仓库：不缓存，每问一次就跑一次 git。

use std::path::Path;
use std::process::Output;

use poietica_process_host::program::hide_console;
use thiserror::Error;
use tokio::process::Command;

mod review;
mod watch;

pub use review::{commit, file_patch, review};
pub use watch::WatchRegistry;

pub use poietica_review_native::{ChangeStatus, CommitIntent, FileChange, ReviewSnapshot};

#[derive(Debug, Error)]
pub enum GitError {
    #[error("无法启动 git：{0}")]
    Spawn(#[from] std::io::Error),

    #[error("{0}")]
    Refused(String),

    #[error("无法监视工作目录：{0}")]
    Unwatchable(#[from] notify::Error),

    #[error("git 监视器没有可用的 Tokio 运行时：{0}")]
    WatchRuntime(String),

    #[error("无法解析工作目录：{0}")]
    WatchRoot(std::io::Error),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BranchSnapshot {
    pub branch: Option<String>,
    pub detached_at: Option<String>,
    pub branches: Vec<String>,
}

const WORK_TREE_ARGS: &[&str] = &["rev-parse", "--is-inside-work-tree"];
const LOCAL_BRANCH_ARGS: &[&str] = &[
    "for-each-ref",
    "refs/heads",
    "--sort=-committerdate",
    "--format=%(refname:short)",
];

pub(crate) async fn repository_probe(root: &Path) -> Result<Output, GitError> {
    run(root, WORK_TREE_ARGS).await
}

pub(crate) async fn branch_listing(root: &Path) -> Result<Output, GitError> {
    run(root, LOCAL_BRANCH_ARGS).await
}

pub(crate) fn is_work_tree(probe: &Output) -> bool {
    probe.status.success() && line(&probe.stdout) == "true"
}

pub(crate) fn git_missing(error: &GitError) -> bool {
    matches!(
        error,
        GitError::Spawn(source) if source.kind() == std::io::ErrorKind::NotFound
    )
}

pub async fn snapshot(root: &Path) -> Result<Option<BranchSnapshot>, GitError> {
    let queried = tokio::try_join!(
        repository_probe(root),
        run(root, &["branch", "--show-current"]),
        branch_listing(root),
    );
    let (probe, head, refs) = match queried {
        Ok(outputs) => outputs,
        Err(error) if git_missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };

    if !is_work_tree(&probe) {
        return Ok(None);
    }

    let head = expect_ok(head)?;
    let name = line(&head.stdout);
    let branch = if name.is_empty() { None } else { Some(name) };

    let detached_at = if branch.is_some() {
        None
    } else {
        let commit = expect_ok(run(root, &["rev-parse", "--short", "HEAD"]).await?)?;
        Some(line(&commit.stdout))
    };

    Ok(Some(BranchSnapshot {
        branch,
        detached_at,
        branches: branches_from(refs)?,
    }))
}
pub(crate) fn branches_from(refs: Output) -> Result<Vec<String>, GitError> {
    let refs = expect_ok(refs)?;
    Ok(String::from_utf8_lossy(&refs.stdout)
        .lines()
        .map(str::trim)
        .filter(|held| !held.is_empty())
        .map(ToOwned::to_owned)
        .collect())
}

pub async fn switch(root: &Path, branch: &str) -> Result<BranchSnapshot, GitError> {
    checked_name(branch)?;
    expect_ok(run(root, &["switch", branch]).await?)?;

    refreshed(root).await
}

pub async fn create(root: &Path, branch: &str) -> Result<BranchSnapshot, GitError> {
    checked_name(branch)?;
    expect_ok(run(root, &["switch", "-c", branch]).await?)?;

    refreshed(root).await
}

pub(crate) fn still_a_worktree<T>(found: Option<T>) -> Result<T, GitError> {
    found.ok_or_else(|| GitError::Refused("这个目录已经不是 git 工作区".to_owned()))
}

async fn refreshed(root: &Path) -> Result<BranchSnapshot, GitError> {
    still_a_worktree(snapshot(root).await?)
}

/* 只挡把名字读成命令行开关的那一类注入；其余交给 git 自己的 check-ref-format。 */
fn checked_name(branch: &str) -> Result<(), GitError> {
    if branch.trim().is_empty() || branch.starts_with('-') {
        return Err(GitError::Refused(format!("无效的分支名：{branch}")));
    }

    Ok(())
}

pub(crate) async fn run(root: &Path, args: &[&str]) -> Result<Output, GitError> {
    let mut command = Command::new("git");
    command.arg("-C").arg(root).args(args);

    // 桌面进程策略全仓一份：crates/process-host 的 hide_console。
    hide_console(command.as_std_mut());

    Ok(command.output().await?)
}

pub(crate) fn expect_ok(output: Output) -> Result<Output, GitError> {
    if output.status.success() {
        return Ok(output);
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let reason = stderr.trim();

    Err(GitError::Refused(if reason.is_empty() {
        "git 没有说明原因就失败了".to_owned()
    } else {
        reason.to_owned()
    }))
}

fn line(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim().to_owned()
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        clippy::unwrap_used,
        clippy::panic,
        reason = "测试面对的是已知夹具，假设破了就该大声失败"
    )]

    use std::path::Path;

    use super::{GitError, checked_name, create, snapshot, switch};

    #[test]
    fn names_that_read_as_flags_are_refused_before_git_runs() {
        assert!(matches!(checked_name("-x"), Err(GitError::Refused(_))));
        assert!(matches!(checked_name("   "), Err(GitError::Refused(_))));
        assert!(checked_name("feature/one").is_ok());
    }

    /// 探测与生产同产地：process-host 的 which 解析；机器上没有 git 时这些测试直接返回。
    fn git_available() -> bool {
        poietica_process_host::program::resolve_program("git").is_ok()
    }

    async fn init_repo(root: &Path) {
        let steps: [&[&str]; 4] = [
            &["init", "--initial-branch=trunk"],
            &["config", "user.email", "test@example.com"],
            &["config", "user.name", "test"],
            &["commit", "--allow-empty", "--message", "root"],
        ];

        for args in steps {
            let done = tokio::process::Command::new("git")
                .arg("-C")
                .arg(root)
                .args(args)
                .output()
                .await
                .expect("git 应当能启动");
            assert!(done.status.success(), "git 夹具步骤失败：{args:?}");
        }
    }

    #[tokio::test]
    async fn plain_directory_has_no_snapshot() {
        if !git_available() {
            return;
        }

        let dir = tempfile::tempdir().expect("tempdir");

        assert_eq!(snapshot(dir.path()).await.expect("snapshot"), None);
    }

    #[tokio::test]
    async fn create_and_switch_round_trip() {
        if !git_available() {
            return;
        }

        let dir = tempfile::tempdir().expect("tempdir");
        init_repo(dir.path()).await;

        let opened = snapshot(dir.path())
            .await
            .expect("snapshot")
            .expect("是仓库");
        assert_eq!(opened.branch.as_deref(), Some("trunk"));
        assert!(opened.branches.contains(&"trunk".to_owned()));

        let created = create(dir.path(), "feature/one").await.expect("create");
        assert_eq!(created.branch.as_deref(), Some("feature/one"));

        let back = switch(dir.path(), "trunk").await.expect("switch");
        assert_eq!(back.branch.as_deref(), Some("trunk"));
        assert!(back.branches.contains(&"feature/one".to_owned()));

        assert!(matches!(
            switch(dir.path(), "missing").await,
            Err(GitError::Refused(_))
        ));
    }
}
