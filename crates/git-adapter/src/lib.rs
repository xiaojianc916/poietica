//! 一个工作目录的 git 分支问答与操作。
//!
//! 分支状态的唯一真相是磁盘上的仓库，所以这里不缓存：每问一次就跑一次 git。
//! 走 git CLI 而不是 libgit2 绑定，是这个场景的标杆做法 —— VS Code 内置的
//! git 扩展与 JetBrains 的 git4idea 都外调 git 可执行文件：仓库可能带
//! worktree、sparse、submodule 与自定义 hooks，只有 git 自己的解释永远与
//! 用户在终端里看到的一致；libgit2 还会把一整个 C 库编进产物，换来的是
//! 这里用不到的对象库读写。
//!
//! 边界：这个 crate 不认识 Tauri，也不判断「哪个目录允许被操作」—— 那是
//! 命令层的事。它拿到路径与分支名，交还快照或 git 自己的拒绝理由。审查面
//! 的领域类型与 porcelain 解码在 crates/review，这里只执行与拼装。

use std::path::Path;
use std::process::Output;

use poietica_process_host::program::hide_console;
use thiserror::Error;
use tokio::process::Command;

mod review;
mod watch;

pub use review::{commit, file_patch, review};
pub use watch::WatchRegistry;

/// 审查面的领域类型由 review 领域拥有；从这里转发，消费者不必两处 import。
pub use poietica_review_native::{ChangeStatus, CommitIntent, FileChange, ReviewSnapshot};

/// git 起不来，或它自己说了不。
#[derive(Debug, Error)]
pub enum GitError {
    /// git 可执行文件起不来。
    #[error("无法启动 git：{0}")]
    Spawn(#[from] std::io::Error),

    /// git 拒绝了这次操作：stderr 原样带回，那是用户唯一拿得去修正的信息。
    #[error("{0}")]
    Refused(String),

    /// 监视挂不上：平台句柄耗尽，或目录在挂之前就没了。
    #[error("无法监视工作目录：{0}")]
    Unwatchable(#[from] notify::Error),

    #[error("git 监视器没有可用的 Tokio 运行时：{0}")]
    WatchRuntime(String),

    #[error("无法解析工作目录：{0}")]
    WatchRoot(std::io::Error),
}

/// 一个仓库此刻的分支快照。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BranchSnapshot {
    /// 当前检出的分支；HEAD 分离时为 None。
    pub branch: Option<String>,
    /// HEAD 分离时所在提交的短号；在分支上时为 None。
    pub detached_at: Option<String>,
    /// 本地分支，按最近提交排序 —— 换分支的人要找的多半是刚用过的那个。
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

/// 问一个目录的分支快照。不是工作区、或机器没有 git，都是 None：这项能力在
/// 那里不存在，界面据此整个消失，不是错误。
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

    /* 分离 HEAD 才多问一次提交号；普通分支只需一轮并发查询。 */
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
/// 解析已经取回的本地分支清单；查询时机由调用方统一编排。
pub(crate) fn branches_from(refs: Output) -> Result<Vec<String>, GitError> {
    let refs = expect_ok(refs)?;
    Ok(String::from_utf8_lossy(&refs.stdout)
        .lines()
        .map(str::trim)
        .filter(|held| !held.is_empty())
        .map(ToOwned::to_owned)
        .collect())
}

/// 检出一个已有分支，交还盘面上的新快照。
pub async fn switch(root: &Path, branch: &str) -> Result<BranchSnapshot, GitError> {
    checked_name(branch)?;
    expect_ok(run(root, &["switch", branch]).await?)?;

    refreshed(root).await
}

/// 创建并检出一个新分支，交还盘面上的新快照。名字是否合法由 git 判 ——
/// check-ref-format 的规则它自己最全，这里不抄第二份。
pub async fn create(root: &Path, branch: &str) -> Result<BranchSnapshot, GitError> {
    checked_name(branch)?;
    expect_ok(run(root, &["switch", "-c", branch]).await?)?;

    refreshed(root).await
}

/// 操作刚成功的目录突然不是仓库，只可能是外部世界在并发改它 —— 照实说。
async fn refreshed(root: &Path) -> Result<BranchSnapshot, GitError> {
    snapshot(root)
        .await?
        .ok_or_else(|| GitError::Refused("这个目录已经不是 git 工作区".to_owned()))
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

    /// 机器上没有 git 时这些测试没有对象，直接返回 —— 能力缺席不是失败。
    /// 探测与生产同产地：process-host 的 which 解析。
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
