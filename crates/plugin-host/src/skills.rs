//! 技能目录的搬入、删除、列举与停用。
//!
//! 技能没有清单也没有账本：判据是 SKILL.md，落点是 skills/<name>/。这里只搬字节，
//! 路径段在唯一拼接点验证，前言的语义归渲染层。

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::error::{HostError, Result};
use crate::layout::{DISABLED_SKILL_FILENAME, SKILL_FILENAME, locate_skill_root};
use crate::staging::Staging;

/// 一次列举最多报这么多行。扫描在命令线程上同步跑，目录再大也不该把它拖住。
const SCAN_CAP: usize = 500;

/// SKILL.md 读多少字节。前言在开头，正文由 CLI 自己读。
const DOCUMENT_MAX_BYTES: u64 = 256 * 1024;

fn skill_directory(skills_root: &Path, name: &str) -> Result<PathBuf> {
    if !crate::layout::is_safe_segment(name) {
        return Err(HostError::UnsafeSegment);
    }

    Ok(skills_root.join(name))
}

/// 盘上的一个技能目录。
#[derive(Debug)]
pub struct ScannedSkill {
    /// 目录名，同时是它的身份。
    pub name: String,
    /// SKILL.md 在（true），还是被改名成 SKILL.md.disabled（false）。
    pub enabled: bool,
    /// SKILL.md 原文，截到 DOCUMENT_MAX_BYTES。
    pub document: String,
}

/// skills/ 下的技能目录，按名字排序。两个判据文件都没有的目录不是技能。
pub fn scan_skills(skills_root: &Path) -> Result<Vec<ScannedSkill>> {
    let mut found = Vec::new();

    for entry in fs::read_dir(skills_root)?.flatten() {
        if found.len() >= SCAN_CAP {
            break;
        }

        let path = entry.path();

        let Some(name) = path.file_name().and_then(|it| it.to_str()) else {
            continue;
        };

        let live = path.join(SKILL_FILENAME);
        let parked = path.join(DISABLED_SKILL_FILENAME);
        let enabled = live.is_file();

        let document = if enabled {
            live
        } else if parked.is_file() {
            parked
        } else {
            continue;
        };

        found.push(ScannedSkill {
            name: name.to_owned(),
            enabled,
            document: head(&document)?,
        });
    }

    found.sort_by(|left, right| left.name.cmp(&right.name));

    Ok(found)
}

/// 停用与启用：SKILL.md 与 SKILL.md.disabled 之间改名，正文一个字节不动。
///
/// 已经在目标状态上就什么也不做 —— 幂等，且两个文件都在时谁也不覆盖。
pub fn set_skill_enabled(skills_root: &Path, name: &str, enabled: bool) -> Result<()> {
    let directory = skill_directory(skills_root, name)?;
    let live = directory.join(SKILL_FILENAME);
    let parked = directory.join(DISABLED_SKILL_FILENAME);
    let (from, to) = if enabled {
        (parked, live)
    } else {
        (live, parked)
    };

    if to.is_file() || !from.is_file() {
        return Ok(());
    }

    fs::rename(from, to)?;

    Ok(())
}

/// 文件开头那一段。
fn head(path: &Path) -> Result<String> {
    let mut bytes = Vec::new();

    fs::File::open(path)?
        .take(DOCUMENT_MAX_BYTES)
        .read_to_end(&mut bytes)?;

    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// 认领：暂存里的技能根搬进 skills/<name>/。已存在的同名目录被原子换掉。
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

/// 删掉一个技能目录。不在了视为成功：删除的语义是「之后它不在」。
pub fn remove_skill(skills_root: &Path, name: &str) -> Result<()> {
    let target = skill_directory(skills_root, name)?;

    if target.exists() {
        fs::remove_dir_all(&target)?;
    }

    Ok(())
}
