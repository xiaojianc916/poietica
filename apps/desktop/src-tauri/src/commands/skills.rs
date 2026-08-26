//! 技能的取用、落盘、列举与停用。
//!
//! 「装了哪些技能」的唯一真相是本机 skills/ 目录：含 SKILL.md 的子目录是一个技能，
//! 改名成 SKILL.md.disabled 就是停用。这里搬字节、报事实，前言解析归渲染层。

use std::fs;
use std::path::PathBuf;

use poietica_plugin_host_native as host;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, command};

use crate::commands::agent_setup::profile::agent_home_directory;
use crate::commands::plugins::{PluginFetch, staged_fetch, staging_root};
use crate::error::{Error, IpcError, Result};

type SkillsCommandResult<T> = std::result::Result<T, IpcError>;

const SKILLS_DIRECTORY: &str = "skills";

fn skills_root(app: &AppHandle) -> Result<PathBuf> {
    let dir = agent_home_directory(app)?.join(SKILLS_DIRECTORY);
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn skill_failure(cause: impl std::fmt::Display) -> Error {
    log::warn!("skill operation failed: {cause}");
    Error::Plugin(cause.to_string())
}

/// 已解到暂存区、等认领的一份。
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillStaged {
    pub staging_id: String,
    pub skill_md: String,
}

/// 本机 skills/ 里的一个技能目录。
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillRecord {
    /// 目录名。停用、启用、卸载都按它寻址。
    pub name: String,
    pub enabled: bool,
    /// SKILL.md 原文。前言解析在渲染层只有一处。
    pub document: String,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillCommitRequest {
    pub staging_id: String,
    /// 落盘的目录名。渲染层从前言里读出，这一侧只验安全性。
    pub name: String,
    pub subdirectory: Option<String>,
}

/// 本机 skills/ 里装着哪些。启用状态与 SKILL.md 原文一并交回，界面不必再问第二遍。
#[command]
#[specta::specta]
pub async fn skills_list(app: AppHandle) -> SkillsCommandResult<Vec<SkillRecord>> {
    (|| -> Result<Vec<SkillRecord>> {
        Ok(host::scan_skills(&skills_root(&app)?)
            .map_err(skill_failure)?
            .into_iter()
            .map(|skill| SkillRecord {
                name: skill.name,
                enabled: skill.enabled,
                document: skill.document,
            })
            .collect())
    })()
    .map_err(IpcError::from)
}

/// 取件到暂存区：与插件安装共用同一条管线（plugins.rs 的 staged_fetch），判据换成
/// SKILL.md。
#[command]
#[specta::specta]
pub async fn skills_stage(app: AppHandle, fetch: PluginFetch) -> SkillsCommandResult<SkillStaged> {
    staged_fetch(&app, fetch, skill_failure, |staging, subdirectory| {
        let staging_id = staging.identifier().to_owned();

        let Ok(root) = host::locate_skill_root(staging.path(), subdirectory) else {
            return Err(skill_failure("这个来源里没有 SKILL.md，它不是一个技能目录"));
        };

        let skill_md =
            fs::read_to_string(root.join(host::SKILL_FILENAME)).map_err(skill_failure)?;

        Ok(SkillStaged {
            staging_id,
            skill_md,
        })
    })
    .await
    .map_err(IpcError::from)
}

/// 认领：暂存里的技能根搬进 skills/<name>/。同名目录被原子换掉，重装即覆盖。
#[command]
#[specta::specta]
pub async fn skills_commit(app: AppHandle, request: SkillCommitRequest) -> SkillsCommandResult<()> {
    (|| -> Result<()> {
        let staging = host::Staging::open(&staging_root(&app)?, &request.staging_id)
            .map_err(skill_failure)?;

        host::install_skill(
            staging,
            &skills_root(&app)?,
            &request.name,
            request.subdirectory.as_deref(),
        )
        .map_err(skill_failure)
    })()
    .map_err(IpcError::from)
}

/// 丢掉一份暂存（安装取消或失败后的清理）。
#[command]
#[specta::specta]
pub async fn skills_discard(app: AppHandle, staging_id: String) -> SkillsCommandResult<()> {
    (|| -> Result<()> {
        let staging =
            host::Staging::open(&staging_root(&app)?, &staging_id).map_err(skill_failure)?;

        staging.discard().map_err(skill_failure)
    })()
    .map_err(IpcError::from)
}

/// 卸载：删掉 skills/<name>/。目录不在视为成功，删除因此幂等。
#[command]
#[specta::specta]
pub async fn skills_remove(app: AppHandle, name: String) -> SkillsCommandResult<()> {
    (|| -> Result<()> { host::remove_skill(&skills_root(&app)?, &name).map_err(skill_failure) })()
        .map_err(IpcError::from)
}

/// 停用与启用：SKILL.md 与 SKILL.md.disabled 之间改名，正文不动。
#[command]
#[specta::specta]
pub async fn skills_set_enabled(
    app: AppHandle,
    name: String,
    enabled: bool,
) -> SkillsCommandResult<()> {
    (|| -> Result<()> {
        host::set_skill_enabled(&skills_root(&app)?, &name, enabled).map_err(skill_failure)
    })()
    .map_err(IpcError::from)
}
