use std::path::Path;

use serde::Serialize;
use specta::Type;
use tauri::command;

use crate::error::{Error, IpcError};

/// 一个工作目录此刻的分支快照。branch 为空即 HEAD 分离，detachedAt 给出所在短号。
#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitBranches {
    pub branch: Option<String>,
    pub detached_at: Option<String>,
    pub branches: Vec<String>,
}

impl From<poietica_git_native::BranchSnapshot> for GitBranches {
    fn from(snapshot: poietica_git_native::BranchSnapshot) -> Self {
        Self {
            branch: snapshot.branch,
            detached_at: snapshot.detached_at,
            branches: snapshot.branches,
        }
    }
}

/* git 的拒绝理由原样透出（error.rs 的 Git 变体），与 AgentCli 同一判据：
本机 CLI 对本机用户说的话不是秘密，而是用户唯一拿得去修正的信息。 */
fn surfaced(error: poietica_git_native::GitError) -> IpcError {
    IpcError::from(Error::Git(error.to_string()))
}

/// 问一个目录的分支快照。不是 git 仓库、或机器没有 git，都是 None：
/// 界面据此整个隐藏分支 chip，这不是错误。
#[command]
#[specta::specta]
pub async fn git_branches(root: String) -> Result<Option<GitBranches>, IpcError> {
    poietica_git_native::snapshot(Path::new(&root))
        .await
        .map(|held| held.map(GitBranches::from))
        .map_err(surfaced)
}

/// 检出一个已有分支。成功即交回盘面上的新快照 —— 界面不自己拼「操作后的世界」。
#[command]
#[specta::specta]
pub async fn git_switch_branch(root: String, branch: String) -> Result<GitBranches, IpcError> {
    poietica_git_native::switch(Path::new(&root), &branch)
        .await
        .map(GitBranches::from)
        .map_err(surfaced)
}

/// 创建并检出一个新分支，交回盘面上的新快照。名字合法性由 git 自己判。
#[command]
#[specta::specta]
pub async fn git_create_branch(root: String, branch: String) -> Result<GitBranches, IpcError> {
    poietica_git_native::create(Path::new(&root), &branch)
        .await
        .map(GitBranches::from)
        .map_err(surfaced)
}

/// 一个文件此刻相对 HEAD 的处境。
#[derive(Clone, Copy, Debug, Serialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum GitChangeStatus {
    Added,
    Modified,
    Deleted,
    Untracked,
    Conflicted,
}

/// 工作树里一处变更。path 是仓库根的相对路径。
#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    pub path: String,
    pub status: GitChangeStatus,
    pub staged: bool,
}

impl From<poietica_git_native::ChangeStatus> for GitChangeStatus {
    fn from(status: poietica_git_native::ChangeStatus) -> Self {
        match status {
            poietica_git_native::ChangeStatus::Added => Self::Added,
            poietica_git_native::ChangeStatus::Modified => Self::Modified,
            poietica_git_native::ChangeStatus::Deleted => Self::Deleted,
            poietica_git_native::ChangeStatus::Untracked => Self::Untracked,
            poietica_git_native::ChangeStatus::Conflicted => Self::Conflicted,
        }
    }
}

impl From<poietica_git_native::FileChange> for GitFileChange {
    fn from(change: poietica_git_native::FileChange) -> Self {
        Self {
            path: change.path,
            status: change.status.into(),
            staged: change.staged,
        }
    }
}

/// 问一个目录此刻的变更清单。不是 git 仓库、或机器没有 git，都是 None。
#[command]
#[specta::specta]
pub async fn git_changes(root: String) -> Result<Option<Vec<GitFileChange>>, IpcError> {
    poietica_git_native::changes(Path::new(&root))
        .await
        .map(|held| held.map(|list| list.into_iter().map(GitFileChange::from).collect()))
        .map_err(surfaced)
}

/// 一个文件此刻相对 HEAD 的统一补丁。未跟踪文件没有基线，界面不会问到这里。
#[command]
#[specta::specta]
pub async fn git_file_patch(root: String, path: String) -> Result<String, IpcError> {
    poietica_git_native::patch(Path::new(&root), &path)
        .await
        .map_err(surfaced)
}

/// 等这个工作树的下一次变化。true = 变了；false = 这一窗里没动，调用方再挂一次。
///
/// 监视与这一次调用同寿，谁创建谁销毁；界面因此不需要刷新按钮。
#[command]
#[specta::specta]
pub async fn git_await_change(root: String) -> Result<bool, IpcError> {
    poietica_git_native::await_change(Path::new(&root))
        .await
        .map_err(surfaced)
}
