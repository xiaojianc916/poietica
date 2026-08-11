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
