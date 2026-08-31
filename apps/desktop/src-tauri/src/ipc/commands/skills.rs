//! Skill installation and managed-library commands.

use std::fs;
use std::path::PathBuf;

use poietica_extension_native as extension;
use poietica_problem::Problem;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, async_runtime, command};

use crate::error::{Error, Result};
use crate::ipc::commands::cli::profile::agent_home_directory;
use crate::ipc::commands::extension::{PluginFetch, staged_fetch, staging_root};

type SkillsCommandResult<T> = std::result::Result<T, Problem>;

const SKILLS_DIRECTORY: &str = "skills";

fn skills_root(app: &AppHandle) -> Result<PathBuf> {
    let directory = agent_home_directory(app)?.join(SKILLS_DIRECTORY);
    fs::create_dir_all(&directory)?;
    Ok(directory)
}

fn skill_failure(cause: impl std::fmt::Display) -> Error {
    log::warn!("skill operation failed: {cause}");
    Error::Plugin(cause.to_string())
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillStaged {
    pub staging_id: String,
    pub skill_md: String,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillRecord {
    pub name: String,
    pub enabled: bool,
    pub document: String,
    pub path: String,
    pub supporting_files: u32,
    pub total_bytes: u32,
    pub modified_at: Option<u32>,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillCommitRequest {
    pub staging_id: String,
    pub name: String,
    pub subdirectory: Option<String>,
}

#[command]
#[specta::specta]
pub async fn skills_list(app: AppHandle) -> SkillsCommandResult<Vec<SkillRecord>> {
    let root = skills_root(&app).map_err(Problem::from)?;
    let scanned = async_runtime::spawn_blocking(move || extension::scan_skills(&root))
        .await
        .map_err(skill_failure)
        .and_then(|result| result.map_err(skill_failure))
        .map_err(Problem::from)?;

    Ok(scanned
        .into_iter()
        .map(|skill| {
            /* 绑定不收 u64：按 dto.rs 同一条规矩收窄，溢出即封顶。 */
            let narrow = |value: u64| u32::try_from(value).unwrap_or(u32::MAX);

            SkillRecord {
                name: skill.name,
                enabled: skill.enabled,
                document: skill.document,
                path: skill.directory.to_string_lossy().into_owned(),
                supporting_files: skill.supporting_files,
                total_bytes: narrow(skill.total_bytes),
                modified_at: skill.modified_at.map(narrow),
            }
        })
        .collect())
}

#[command]
#[specta::specta]
pub async fn skills_stage(app: AppHandle, fetch: PluginFetch) -> SkillsCommandResult<SkillStaged> {
    staged_fetch(&app, fetch, skill_failure, |staging, subdirectory| {
        let staging_id = staging.identifier().to_owned();
        let root = extension::locate_skill_root(staging.path(), subdirectory)
            .map_err(|_| skill_failure("这个来源里没有 SKILL.md，它不是一个技能目录"))?;
        let skill_md =
            fs::read_to_string(root.join(extension::SKILL_FILENAME)).map_err(skill_failure)?;

        Ok(SkillStaged {
            staging_id,
            skill_md,
        })
    })
    .await
    .map_err(Problem::from)
}

#[command]
#[specta::specta]
pub async fn skills_commit(app: AppHandle, request: SkillCommitRequest) -> SkillsCommandResult<()> {
    (|| -> Result<()> {
        let staging = extension::Staging::open(&staging_root(&app)?, &request.staging_id)
            .map_err(skill_failure)?;
        extension::install_skill(
            staging,
            &skills_root(&app)?,
            &request.name,
            request.subdirectory.as_deref(),
        )
        .map_err(skill_failure)
    })()
    .map_err(Problem::from)
}

#[command]
#[specta::specta]
pub async fn skills_discard(app: AppHandle, staging_id: String) -> SkillsCommandResult<()> {
    (|| -> Result<()> {
        let staging =
            extension::Staging::open(&staging_root(&app)?, &staging_id).map_err(skill_failure)?;
        staging.discard().map_err(skill_failure)
    })()
    .map_err(Problem::from)
}

#[command]
#[specta::specta]
pub async fn skills_trash(app: AppHandle, name: String) -> SkillsCommandResult<()> {
    let root = skills_root(&app).map_err(Problem::from)?;
    async_runtime::spawn_blocking(move || extension::trash_skill(&root, &name))
        .await
        .map_err(skill_failure)
        .and_then(|result| result.map_err(skill_failure))
        .map_err(Problem::from)
}

#[command]
#[specta::specta]
pub async fn skills_set_enabled(
    app: AppHandle,
    name: String,
    enabled: bool,
) -> SkillsCommandResult<()> {
    let root = skills_root(&app).map_err(Problem::from)?;
    async_runtime::spawn_blocking(move || extension::set_skill_enabled(&root, &name, enabled))
        .await
        .map_err(skill_failure)
        .and_then(|result| result.map_err(skill_failure))
        .map_err(Problem::from)
}
