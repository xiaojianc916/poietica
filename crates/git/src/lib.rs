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
//! 命令层的事。它拿到路径与分支名，交还快照或 git 自己的拒绝理由。

use std::path::Path;
use std::process::Output;

use thiserror::Error;
use tokio::process::Command;

mod changes;
mod watch;

pub use changes::{ChangeStatus, FileChange, changes, patch};
pub use watch::await_change;

/// GUI 宿主 spawn 控制台程序时，Windows 会给它开一个控制台窗口：选一次工作区
/// 闪一排黑框。同一规则的另一份在 crates/agent-runtime/src/program.rs 的
/// hide_console；crates 相互不依赖（AGENTS.md §3），不能借它的代码，所以各持
/// 一份 —— 它移动时这份注释跟着改。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

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

/// git 在不在、这个目录是不是工作区。两者缺一，这项能力在此处就不存在。
pub(crate) async fn inside_work_tree(root: &Path) -> Result<bool, GitError> {
    let probe = match run(root, &["rev-parse", "--is-inside-work-tree"]).await {
        Ok(output) => output,
        Err(GitError::Spawn(source)) if source.kind() == std::io::ErrorKind::NotFound => {
            return Ok(false);
        }
        Err(error) => return Err(error),
    };

    Ok(probe.status.success() && line(&probe.stdout) == "true")
}

/// 问一个目录的分支快照。不是工作区、或机器没有 git，都是 None：这项能力在
/// 那里不存在，界面据此整个消失，不是错误。
pub async fn snapshot(root: &Path) -> Result<Option<BranchSnapshot>, GitError> {
    if !inside_work_tree(root).await? {
        return Ok(None);
    }

    let head = expect_ok(run(root, &["branch", "--show-current"]).await?)?;
    let name = line(&head.stdout);
    let branch = if name.is_empty() { None } else { Some(name) };

    /* 分离 HEAD 才需要短号。刚 init 还没有提交时走不到这里 ——
    show-current 在未诞生的分支上照样给出名字。 */
    let detached_at = if branch.is_some() {
        None
    } else {
        let commit = expect_ok(run(root, &["rev-parse", "--short", "HEAD"]).await?)?;

        Some(line(&commit.stdout))
    };

    let refs = expect_ok(
        run(
            root,
            &[
                "for-each-ref",
                "refs/heads",
                "--sort=-committerdate",
                "--format=%(refname:short)",
            ],
        )
        .await?,
    )?;

    let branches = String::from_utf8_lossy(&refs.stdout)
        .lines()
        .map(str::trim)
        .filter(|held| !held.is_empty())
        .map(ToOwned::to_owned)
        .collect();

    Ok(Some(BranchSnapshot {
        branch,
        detached_at,
        branches,
    }))
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

    // 同一规则的第二份（第一份见文件头）：tokio 的 Command 直接暴露这个标志。
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }

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
    fn git_available() -> bool {
        which::which("git").is_ok()
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
