//! 技能的取用、落盘与列举。
//!
//! 技能没有账本：CLI 按 skills/<name>/SKILL.md 扫描装载，目录本身是唯一真相，
//! 写进去就是装上，删掉就是卸载。这里搬字节，前言解析归渲染层。

use std::fs;
use std::path::{Path, PathBuf};

use poietica_plugin_host_native as host;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, command};

use crate::commands::agent_setup::profile::agent_home_directory;
use crate::commands::plugins::{PluginFetch, download, staging_root};
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

/// 一个装好的技能。前言由渲染层解析，这里只交 SKILL.md 原文。
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillPayload {
    /// 目录名，同时是 /skill:<name> 的调用名。
    pub name: String,
    pub skill_md: String,
}

/// 已解到暂存区、等认领的一份。
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillStaged {
    pub staging_id: String,
    pub skill_md: String,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillCommitRequest {
    pub staging_id: String,
    /// 落盘的目录名。渲染层从前言里读出，这一侧只验安全性。
    pub name: String,
    pub subdirectory: Option<String>,
}

/// 扫 skills/ 目录：每个含 SKILL.md 的子目录是一个技能。
#[command]
#[specta::specta]
pub async fn skills_list(app: AppHandle) -> SkillsCommandResult<Vec<SkillPayload>> {
    (|| -> Result<Vec<SkillPayload>> {
        let root = skills_root(&app)?;
                let mut found = Vec::new();

        for entry in fs::read_dir(&root)?.flatten() {
            let path = entry.path();

            if !path.is_dir() {
                continue;
            }

            let manifest = path.join(host::SKILL_FILENAME);

            if !manifest.is_file() {
                continue;
            }

            let Some(name) = path.file_name().and_then(|it| it.to_str()) else {
                continue;
            };

            found.push(SkillPayload {
                name: name.to_owned(),
                skill_md: fs::read_to_string(&manifest)?,
            });
        }

        found.sort_by(|left, right| left.name.cmp(&right.name));

        Ok(found)
    })()
    .map_err(IpcError::from)
}

fn discard_or_warn(staging: host::Staging) {
    if let Err(cause) = staging.discard() {
        log::warn!("could not discard failed skill staging: {cause}");
    }
}

/// 取件到暂存区：与插件安装同一条管线，判据换成 SKILL.md。
#[command]
#[specta::specta]
pub async fn skills_stage(app: AppHandle, fetch: PluginFetch) -> SkillsCommandResult<SkillStaged> {
    let bytes = match &fetch {
        PluginFetch::Archive { url, .. } => Some(download(url).await.map_err(IpcError::from)?),
        PluginFetch::Directory { .. } => None,
    };

    (|| -> Result<SkillStaged> {
        let staging = host::Staging::create(&staging_root(&app)?).map_err(skill_failure)?;
        let staging_id = staging.identifier().to_owned();

        let (filled, subdirectory) = match (&fetch, bytes.as_deref()) {
            (PluginFetch::Directory { path }, _) => {
                (host::copy_tree(Path::new(path), staging.path()), None)
            }
            (PluginFetch::Archive { subdirectory, .. }, Some(payload)) => {
                (host::extract_zip(payload, staging.path()), subdirectory.as_deref())
            }
            (PluginFetch::Archive { .. }, None) => {
                unreachable!("archive bytes are downloaded above")
            }
        };

        if let Err(cause) = filled {
            discard_or_warn(staging);
            return Err(skill_failure(cause));
        }

        let root = match host::locate_skill_root(staging.path(), subdirectory) {
            Ok(root) => root,
            Err(_) => {
                discard_or_warn(staging);
                return Err(skill_failure("这个来源里没有 SKILL.md，它不是一个技能目录"));
            }
        };

        let skill_md = match fs::read_to_string(root.join(host::SKILL_FILENAME)) {
            Ok(text) => text,
            Err(cause) => {
                discard_or_warn(staging);
                return Err(skill_failure(cause));
            }
        };

        Ok(SkillStaged { staging_id, skill_md })
    })()
    .map_err(IpcError::from)
}

/// 认领：暂存里的技能根搬进 skills/<name>/。同名目录被原子换掉，重装即覆盖。
#[command]
#[specta::specta]
pub async fn skills_commit(app: AppHandle, request: SkillCommitRequest) -> SkillsCommandResult<()> {
    (|| -> Result<()> {
        if !host::is_safe_segment(&request.name) {
            return Err(skill_failure(format!("技能名不合法：{}", request.name)));
        }

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
    (|| -> Result<()> {
        if !host::is_safe_segment(&name) {
            return Err(skill_failure(format!("技能名不合法：{name}")));
        }

        host::remove_skill(&skills_root(&app)?, &name).map_err(skill_failure)
    })()
    .map_err(IpcError::from)
}
