use std::path::Path;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::command;

use crate::error::Error;
use poietica_problem::Problem;

/// 一个工作目录此刻的分支快照。branch 为空即 HEAD 分离，detachedAt 给出所在短号。
#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitBranches {
    pub branch: Option<String>,
    pub detached_at: Option<String>,
    pub branches: Vec<String>,
}

impl From<poietica_git_adapter_native::BranchSnapshot> for GitBranches {
    fn from(snapshot: poietica_git_adapter_native::BranchSnapshot) -> Self {
        Self {
            branch: snapshot.branch,
            detached_at: snapshot.detached_at,
            branches: snapshot.branches,
        }
    }
}

/* git 的拒绝理由原样透出（error.rs 的 Git 变体），与 AgentCli 同一判据：
本机 CLI 对本机用户说的话不是秘密，而是用户唯一拿得去修正的信息。 */
fn surfaced(error: poietica_git_adapter_native::GitError) -> Problem {
    Problem::from(Error::Git(error.to_string()))
}

/// 问一个目录的分支快照。不是 git 仓库、或机器没有 git，都是 None：
/// 界面据此整个隐藏分支 chip，这不是错误。
#[command]
#[specta::specta]
pub async fn git_branches(root: String) -> Result<Option<GitBranches>, Problem> {
    poietica_git_adapter_native::snapshot(Path::new(&root))
        .await
        .map(|held| held.map(GitBranches::from))
        .map_err(surfaced)
}

/// 检出一个已有分支。成功即交回盘面上的新快照 —— 界面不自己拼「操作后的世界」。
#[command]
#[specta::specta]
pub async fn git_switch_branch(root: String, branch: String) -> Result<GitBranches, Problem> {
    poietica_git_adapter_native::switch(Path::new(&root), &branch)
        .await
        .map(GitBranches::from)
        .map_err(surfaced)
}

/// 创建并检出一个新分支，交回盘面上的新快照。名字合法性由 git 自己判。
#[command]
#[specta::specta]
pub async fn git_create_branch(root: String, branch: String) -> Result<GitBranches, Problem> {
    poietica_git_adapter_native::create(Path::new(&root), &branch)
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

/// 工作树里一处变更。path 是仓库根的相对路径；加减行数由补丁自己数出。
#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    pub path: String,
    pub status: GitChangeStatus,
    pub staged: bool,
}

impl From<poietica_git_adapter_native::ChangeStatus> for GitChangeStatus {
    fn from(status: poietica_git_adapter_native::ChangeStatus) -> Self {
        match status {
            poietica_git_adapter_native::ChangeStatus::Added => Self::Added,
            poietica_git_adapter_native::ChangeStatus::Modified => Self::Modified,
            poietica_git_adapter_native::ChangeStatus::Deleted => Self::Deleted,
            poietica_git_adapter_native::ChangeStatus::Untracked => Self::Untracked,
            poietica_git_adapter_native::ChangeStatus::Conflicted => Self::Conflicted,
        }
    }
}

impl From<poietica_git_adapter_native::FileChange> for GitFileChange {
    fn from(change: poietica_git_adapter_native::FileChange) -> Self {
        Self {
            path: change.path,
            status: change.status.into(),
            staged: change.staged,
        }
    }
}

/// 审查那一格此刻要画的全部事实。
#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitReview {
    pub branch: Option<String>,
    pub detached_at: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub branches: Vec<String>,
    pub changes: Vec<GitFileChange>,
    pub patch: String,
}
impl From<poietica_git_adapter_native::ReviewSnapshot> for GitReview {
    fn from(held: poietica_git_adapter_native::ReviewSnapshot) -> Self {
        Self {
            branch: held.branch,
            detached_at: held.detached_at,
            upstream: held.upstream,
            ahead: held.ahead,
            behind: held.behind,
            branches: held.branches,
            changes: held.changes.into_iter().map(GitFileChange::from).collect(),
            patch: held.patch,
        }
    }
}
/// 问一次审查面：分支、上游、清单与整份补丁。不是 git 仓库、或机器没有 git，
/// 都是 None —— 界面据此整个隐藏这一格，这不是错误。
#[command]
#[specta::specta]
pub async fn git_review(
    root: String,
    base: String,
    context: u32,
    ignore_whitespace: bool,
) -> Result<Option<GitReview>, Problem> {
    poietica_git_adapter_native::review(Path::new(&root), &base, context, ignore_whitespace)
        .await
        .map(|held| held.map(GitReview::from))
        .map_err(surfaced)
}
/// 问一个文件的整份补丁：折叠带上的行由它带回来，取回时机由界面决定。
#[command]
#[specta::specta]
pub async fn git_file_patch(
    root: String,
    base: String,
    path: String,
    ignore_whitespace: bool,
) -> Result<String, Problem> {
    poietica_git_adapter_native::file_patch(Path::new(&root), &base, &path, ignore_whitespace)
        .await
        .map_err(surfaced)
}
/// 提交或推送，成功即交回盘面上的新审查面 —— 界面不自己拼「操作后的世界」。
#[command]
#[specta::specta]
pub async fn git_commit(request: GitCommitRequest) -> Result<GitReview, Problem> {
    poietica_git_adapter_native::commit(
        Path::new(&request.root),
        request.intent.into(),
        &request.message,
        request.stage_all,
        &request.base,
        request.context,
        request.ignore_whitespace,
    )
    .await
    .map(GitReview::from)
    .map_err(surfaced)
}
/// 一次提交动作的意图。
#[derive(Clone, Copy, Debug, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum GitCommitIntent {
    Commit,
    CommitAndPush,
    Push,
}
impl From<GitCommitIntent> for poietica_git_adapter_native::CommitIntent {
    fn from(intent: GitCommitIntent) -> Self {
        match intent {
            GitCommitIntent::Commit => Self::Commit,
            GitCommitIntent::CommitAndPush => Self::CommitAndPush,
            GitCommitIntent::Push => Self::Push,
        }
    }
}
/// 一次提交动作的全部输入。
#[derive(Clone, Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitRequest {
    pub root: String,
    pub intent: GitCommitIntent,
    pub message: String,
    pub stage_all: bool,
    pub base: String,
    pub context: u32,
    pub ignore_whitespace: bool,
}

/// 等这个工作树的下一次变化。true = 变了；false = 这一窗里没动，调用方再挂一次。
///
/// 监视与这一次调用同寿，谁创建谁销毁；界面因此不需要刷新按钮。
#[command]
#[specta::specta]
pub async fn git_await_change(root: String) -> Result<bool, Problem> {
    poietica_git_adapter_native::await_change(Path::new(&root))
        .await
        .map_err(surfaced)
}
