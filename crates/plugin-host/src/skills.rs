//! 技能目录的搬入与删除。
//!
//! 技能没有清单也没有账本：判据是 SKILL.md，落点是 skills/<name>/。这里只搬字节，
//! 名字的合法性由调用方先验，前言的语义归渲染层。

use std::fs;
use std::path::Path;

use crate::error::Result;
use crate::layout::locate_skill_root;
use crate::staging::Staging;

/// 认领：暂存里的技能根搬进 skills/<name>/。已存在的同名目录被原子换掉。
pub fn install_skill(
    staging: Staging,
    skills_root: &Path,
    name: &str,
    subdirectory: Option<&str>,
) -> Result<()> {
    let root = locate_skill_root(staging.path(), subdirectory)?;
    let destination = skills_root.join(name);

    staging.promote(&root, &destination)
}

/// 删掉一个技能目录。不在了视为成功：删除的语义是「之后它不在」。
pub fn remove_skill(skills_root: &Path, name: &str) -> Result<()> {
    let target = skills_root.join(name);

    if target.exists() {
        fs::remove_dir_all(&target)?;
    }

    Ok(())
}
