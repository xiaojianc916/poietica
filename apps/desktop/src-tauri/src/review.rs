use std::path::Path;

use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::Arc;
use tauri::{AppHandle, State, command};
use tauri_specta::Event as _;

use crate::error::Error;
use poietica_problem::Problem;

/// branch 为空即 HEAD 分离，detachedAt 给出所在短号。
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

fn surfaced(error: poietica_git_adapter_native::GitError) -> Problem {
    Problem::from(Error::Git(error.to_string()))
}

/// 非 git 仓库或机器没有 git 时返回 None：界面据此整个隐藏分支 chip，不是错误。
#[command]
#[specta::specta]
pub async fn git_branches(root: String) -> Result<Option<GitBranches>, Problem> {
    poietica_git_adapter_native::snapshot(Path::new(&root))
        .await
        .map(|held| held.map(GitBranches::from))
        .map_err(surfaced)
}

#[command]
#[specta::specta]
pub async fn git_switch_branch(root: String, branch: String) -> Result<GitBranches, Problem> {
    poietica_git_adapter_native::switch(Path::new(&root), &branch)
        .await
        .map(GitBranches::from)
        .map_err(surfaced)
}

#[command]
#[specta::specta]
pub async fn git_create_branch(root: String, branch: String) -> Result<GitBranches, Problem> {
    poietica_git_adapter_native::create(Path::new(&root), &branch)
        .await
        .map(GitBranches::from)
        .map_err(surfaced)
}

#[derive(Clone, Copy, Debug, Serialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum GitChangeStatus {
    Added,
    Modified,
    Deleted,
    Untracked,
    Conflicted,
}

/// path 是仓库根的相对路径。
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
/// 非 git 仓库或机器没有 git 时返回 None：界面据此整个隐藏这一格，不是错误。
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

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitWatchLease {
    pub token: String,
    pub root: String,
}

#[derive(Clone, Debug, Deserialize, tauri_specta::Event, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitWorkingTreeChanged {
    pub root: String,
}

#[command]
#[specta::specta]
pub async fn git_watch_start(
    app: AppHandle,
    watches: State<'_, poietica_git_adapter_native::WatchRegistry>,
    root: String,
) -> Result<GitWatchLease, Problem> {
    let token = uuid::Uuid::now_v7().to_string();
    let emitter = app.clone();
    let canonical = watches
        .acquire(
            Path::new(&root),
            token.clone(),
            Arc::new(move |changed| {
                if let Err(error) = (GitWorkingTreeChanged {
                    root: changed.to_string_lossy().into_owned(),
                })
                .emit(&emitter)
                {
                    log::warn!("could not announce a working-tree change: {error}");
                }
            }),
        )
        .map_err(surfaced)?;
    Ok(GitWatchLease {
        token,
        root: canonical.to_string_lossy().into_owned(),
    })
}

#[command]
#[specta::specta]
pub async fn git_watch_stop(
    watches: State<'_, poietica_git_adapter_native::WatchRegistry>,
    token: String,
) -> Result<(), Problem> {
    if watches.release(&token) {
        Ok(())
    } else {
        Err(Error::Validation("unknown git watch lease".to_owned()).into())
    }
}
