//! Managed skill discovery and lifecycle operations.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use walkdir::WalkDir;

use crate::error::{ExtensionError, Result};
use crate::layout::{DISABLED_SKILL_FILENAME, SKILL_FILENAME, locate_skill_root};
use crate::staging::Staging;

const SCAN_CAP: usize = 500;
const DOCUMENT_MAX_BYTES: u64 = 256 * 1024;
const WALK_MAX_DEPTH: usize = 6;
const WALK_MAX_FILES: u32 = 500;

fn skill_directory(skills_root: &Path, name: &str) -> Result<PathBuf> {
    if !crate::layout::is_safe_segment(name) {
        return Err(ExtensionError::UnsafeSegment);
    }

    Ok(skills_root.join(name))
}

#[derive(Debug)]
pub struct ScannedSkill {
    pub name: String,
    pub enabled: bool,
    pub document: String,
    pub directory: PathBuf,
    pub supporting_files: u32,
    pub total_bytes: u64,
    pub modified_at: Option<u64>,
}

pub fn scan_skills(skills_root: &Path) -> Result<Vec<ScannedSkill>> {
    let mut entries = fs::read_dir(skills_root)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(fs::DirEntry::file_name);

    let mut found = Vec::new();

    for entry in entries.into_iter().take(SCAN_CAP) {
        let directory = entry.path();
        if !directory.is_dir() {
            continue;
        }

        let Some(name) = directory.file_name().and_then(|value| value.to_str()) else {
            continue;
        };

        let live = directory.join(SKILL_FILENAME);
        let parked = directory.join(DISABLED_SKILL_FILENAME);
        let (document_path, enabled) = if live.is_file() {
            (live, true)
        } else if parked.is_file() {
            (parked, false)
        } else {
            continue;
        };

        let (supporting_files, total_bytes) = measure(&directory)?;
        let modified_at = fs::metadata(&document_path)
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs());

        found.push(ScannedSkill {
            name: name.to_owned(),
            enabled,
            document: head(&document_path)?,
            directory,
            supporting_files,
            total_bytes,
            modified_at,
        });
    }

    Ok(found)
}

pub fn set_skill_enabled(skills_root: &Path, name: &str, enabled: bool) -> Result<()> {
    let directory = skill_directory(skills_root, name)?;
    let live = directory.join(SKILL_FILENAME);
    let parked = directory.join(DISABLED_SKILL_FILENAME);

    if enabled {
        if live.is_file() || !parked.is_file() {
            return Ok(());
        }
        fs::rename(parked, live)?;
        return Ok(());
    }

    if !live.is_file() {
        return Ok(());
    }
    if parked.is_file() {
        fs::remove_file(&parked)?;
    }
    fs::rename(live, parked)?;

    Ok(())
}

fn head(path: &Path) -> Result<String> {
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(DOCUMENT_MAX_BYTES)
        .read_to_end(&mut bytes)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn measure(directory: &Path) -> Result<(u32, u64)> {
    let mut files = 0_u32;
    let mut bytes = 0_u64;

    for entry in WalkDir::new(directory)
        .follow_links(false)
        .max_depth(WALK_MAX_DEPTH)
    {
        let entry = entry?;
        if !entry.file_type().is_dir() {
            files = files.saturating_add(1);
            bytes = bytes.saturating_add(entry.metadata()?.len());
        }

        if files >= WALK_MAX_FILES {
            break;
        }
    }

    Ok((files.saturating_sub(1), bytes))
}

pub fn install_skill(
    staging: Staging,
    skills_root: &Path,
    name: &str,
    subdirectory: Option<&str>,
) -> Result<()> {
    let root = locate_skill_root(staging.path(), subdirectory)?;
    let destination = skill_directory(skills_root, name)?;
    staging.promote(&root, &destination)
}

pub fn trash_skill(skills_root: &Path, name: &str) -> Result<()> {
    let target = skill_directory(skills_root, name)?;
    if !target.exists() {
        return Ok(());
    }

    trash::delete(&target).map_err(|error| ExtensionError::Trash(error.to_string()))
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        reason = "test fixtures must fail loudly when filesystem setup fails"
    )]

    use super::*;

    #[test]
    fn scan_reports_content_footprint_and_toggle_round_trips() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let skill = temporary.path().join("review");
        fs::create_dir_all(&skill).expect("skill directory");
        fs::write(
            skill.join(SKILL_FILENAME),
            "---\nname: review\ndescription: Review changes\n---\nInspect the diff.",
        )
        .expect("skill document");
        fs::write(skill.join("checklist.md"), "tests\nerrors\n").expect("supporting file");

        let catalog = scan_skills(temporary.path()).expect("scan");
        assert_eq!(catalog.len(), 1);
        let first = catalog.first().expect("the one scanned skill");
        assert_eq!(first.name, "review");
        assert_eq!(first.supporting_files, 1);
        assert!(first.total_bytes > 0);
        assert!(first.modified_at.is_some());

        set_skill_enabled(temporary.path(), "review", false).expect("disable");
        assert!(skill.join(DISABLED_SKILL_FILENAME).is_file());
        set_skill_enabled(temporary.path(), "review", true).expect("enable");
        assert!(skill.join(SKILL_FILENAME).is_file());
    }
}
