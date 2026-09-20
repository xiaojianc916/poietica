use std::fs;
use std::io::{ErrorKind, Write};
use std::path::Path;

use tempfile::NamedTempFile;

use crate::error::Result;

pub fn read_optional(path: &Path) -> Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(contents) => Ok(Some(contents)),
        Err(cause) if cause.kind() == ErrorKind::NotFound => Ok(None),
        Err(cause) => Err(cause.into()),
    }
}

/// 临时文件必须与目标同目录：跨卷 rename 会失败。
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
