use std::fs;
use std::io::Cursor;
use std::path::Path;

use walkdir::WalkDir;
use zip::ZipArchive;

use crate::error::{ExtensionError, Result};

/// 把一份 zip 的内容解到目标目录下。
///
/// 越界防护用 zip crate 自己的 enclosed_name()：那是这个库为 zip slip 提供的 API，
/// 一并拒绝绝对路径、".." 与 Windows 盘符前缀。自己写字符串检查只会漏掉其中一类。
pub fn extract_zip(bytes: &[u8], destination: &Path) -> Result<()> {
    let mut archive = ZipArchive::new(Cursor::new(bytes))?;

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;

        let Some(relative) = entry.enclosed_name() else {
            return Err(ExtensionError::UnsafeEntry);
        };

        let target = destination.join(relative);

        if entry.is_dir() {
            fs::create_dir_all(&target)?;
            continue;
        }

        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }

        let mut file = fs::File::create(&target)?;

        std::io::copy(&mut entry, &mut file)?;
    }

    Ok(())
}

/// 把一棵目录树整个拷到另一处。
///
/// 不跟随符号链接：插件目录里的链接可能指向仓库外的任何地方，跟过去等于把那些
/// 东西也装进托管副本。walkdir 默认就不跟随，写出来是为了让这个判断留在代码里。
pub fn copy_tree(source: &Path, destination: &Path) -> Result<()> {
    for entry in WalkDir::new(source).follow_links(false) {
        let entry = entry?;
        let target = destination.join(entry.path().strip_prefix(source)?);

        if entry.file_type().is_dir() {
            fs::create_dir_all(&target)?;
            continue;
        }

        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }

        fs::copy(entry.path(), &target)?;
    }

    Ok(())
}
