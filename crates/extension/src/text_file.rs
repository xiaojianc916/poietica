use std::fs;
use std::io::{ErrorKind, Write};
use std::path::Path;

use tempfile::NamedTempFile;

use crate::error::Result;

/// 读一份 UTF-8 文本，文件不存在时返回 None。
///
/// 「还没有这个文件」不是错误：第一次打开插件面板时 installed.json 本来就不存在。
/// 折成错误，调用方就得靠 message 去分辨两种情况。
pub fn read_optional(path: &Path) -> Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(contents) => Ok(Some(contents)),
        Err(cause) if cause.kind() == ErrorKind::NotFound => Ok(None),
        Err(cause) => Err(cause.into()),
    }
}

/// 原子写：同目录临时文件加 rename 覆盖。
///
/// 临时文件必须与目标同目录 —— 跨卷 rename 会失败，而系统临时目录与数据根经常不在
/// 一个卷上，NamedTempFile::new_in 正是为这件事存在的；它的 Drop 会删掉没能 persist
/// 的那一份，所以中途失败不留半成品，不需要自己写清理。std 的 fs::rename 在 Windows
/// 上用带 MOVEFILE_REPLACE_EXISTING 的 MoveFileEx，与 POSIX 语义一致：断电只会留下
/// 旧的那一份或新的那一份。
pub fn write_atomic(path: &Path, contents: &str) -> Result<()> {
    let directory = path
        .parent()
        .ok_or_else(|| std::io::Error::new(ErrorKind::InvalidInput, "path has no parent"))?;

    fs::create_dir_all(directory)?;

    let mut file = NamedTempFile::new_in(directory)?;

    file.write_all(contents.as_bytes())?;
    file.persist(path).map_err(|failure| failure.error)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        reason = "a broken fixture assumption must fail the test loudly"
    )]

    use tempfile::TempDir;

    use super::{read_optional, write_atomic};

    #[test]
    fn a_missing_file_reads_as_absent() {
        let root = TempDir::new().expect("temporary directory");

        assert!(
            read_optional(&root.path().join("installed.json"))
                .expect("a read")
                .is_none()
        );
    }

    #[test]
    fn writing_twice_leaves_only_the_second_version() {
        let root = TempDir::new().expect("temporary directory");
        let target = root.path().join("nested/installed.json");

        write_atomic(&target, "one").expect("first write");
        write_atomic(&target, "two").expect("second write");

        assert_eq!(
            read_optional(&target).expect("a read").expect("contents"),
            "two"
        );
    }
}
