//! Content-addressed bytes. Call blocking filesystem operations off async executor threads.

use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;
use thiserror::Error;

use crate::is_content_hash;

const STAGING_DIRECTORY: &str = "tmp";

#[derive(Debug, Error)]
pub enum BlobError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("attachment hash is not a canonical sha256 digest")]
    InvalidHash,
    #[error("attachment content does not match its digest")]
    Integrity,
    #[error("attachment length overflow")]
    Length,
}

#[derive(Clone, Debug)]
pub struct Blob {
    pub hash: String,
    pub byte_size: u64,
}

pub fn blob_path(root: &Path, hash: &str) -> Result<PathBuf, BlobError> {
    let shard = hash
        .get(0..2)
        .filter(|_| is_content_hash(hash))
        .ok_or(BlobError::InvalidHash)?;
    Ok(root.join(shard).join(hash))
}

pub fn read_blob(root: &Path, hash: &str) -> Result<Vec<u8>, BlobError> {
    let bytes = fs::read(blob_path(root, hash)?)?;
    if hex::encode(Sha256::digest(&bytes)) != hash {
        return Err(BlobError::Integrity);
    }
    Ok(bytes)
}

pub fn store_bytes(root: &Path, bytes: &[u8]) -> Result<Blob, BlobError> {
    let hash = hex::encode(Sha256::digest(bytes));
    let byte_size = u64::try_from(bytes.len()).map_err(|_| BlobError::Length)?;
    let destination = blob_path(root, &hash)?;
    match fs::read(&destination) {
        Ok(present) if present == bytes => return Ok(Blob { hash, byte_size }),
        Ok(_) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let shard = destination.parent().ok_or(BlobError::InvalidHash)?;
    fs::create_dir_all(shard)?;
    let staging = root.join(STAGING_DIRECTORY);
    fs::create_dir_all(&staging)?;
    let mut pending = NamedTempFile::new_in(&staging)?;
    pending.write_all(bytes)?;
    pending.as_file().sync_all()?;
    match pending.persist(&destination) {
        Ok(persisted) => persisted.sync_all()?,
        Err(failure) => {
            // Concurrent winners publish identical bytes; on Windows replacing the
            // still-open winner fails, so accept the verified destination.
            match fs::read(&destination) {
                Ok(present) if present == bytes => {}
                _ => return Err(BlobError::Io(failure.error)),
            }
        }
    }
    // Atomic visibility and power-loss durability are different guarantees.
    #[cfg(unix)]
    fs::File::open(shard)?.sync_all()?;
    Ok(Blob { hash, byte_size })
}

pub fn forget_blob(root: &Path, hash: &str) -> Result<(), BlobError> {
    match fs::remove_file(blob_path(root, hash)?) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        clippy::unwrap_used,
        clippy::panic,
        clippy::indexing_slicing,
        clippy::shadow_unrelated,
        reason = "tests operate on known-good fixtures; a broken assumption must fail the test loudly"
    )]

    use super::{Blob, blob_path, forget_blob, is_content_hash, store_bytes};
    use std::fs;

    /// 一间自带清理的临时仓。
    ///
    /// 前缀是留着的：TempDir 默认叫 .tmpXXXXXX，谁都认不出那是谁掉的。测试进程
    /// 被硬杀时 drop 不跑，残留得能一眼归到我们头上。
    fn scratch() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("poietica-attachments-")
            .tempdir()
            .expect("scratch directory")
    }

    #[test]
    fn the_same_bytes_occupy_one_file_however_often_they_are_sent() {
        let scratch = scratch();

        let first: Blob = store_bytes(scratch.path(), b"an image").expect("first send");
        let second: Blob = store_bytes(scratch.path(), b"an image").expect("second send");

        assert_eq!(first.hash, second.hash, "内容一样，身份就一样");
        assert_eq!(first.byte_size, 8);

        let path = blob_path(scratch.path(), &first.hash).expect("path");

        assert!(path.is_file());
        assert_eq!(
            fs::read(&path).expect("stored bytes"),
            b"an image",
            "第二次落盘不该把已经好好躺着的字节改坏"
        );
    }

    #[test]
    fn a_digest_is_sharded_by_its_first_two_characters() {
        let scratch = scratch();
        let blob = store_bytes(scratch.path(), b"sharded").expect("send");
        let path = blob_path(scratch.path(), &blob.hash).expect("path");

        let shard = path
            .parent()
            .and_then(|parent| parent.file_name())
            .and_then(|name| name.to_str())
            .expect("shard directory");

        assert_eq!(shard.len(), 2);
        assert!(blob.hash.starts_with(shard));
    }

    #[test]
    fn nothing_that_is_not_a_digest_can_reach_the_filesystem() {
        let scratch = scratch();

        for hostile in [
            "..",
            "../../etc/passwd",
            "",
            &"A".repeat(64),
            &"a".repeat(63),
        ] {
            assert!(!is_content_hash(hostile), "{hostile} 不是摘要");
            assert!(
                blob_path(scratch.path(), hostile).is_err(),
                "路径是从 hash 拼出来的，所以拒绝必须发生在拼之前: {hostile}"
            );
        }
    }

    #[test]
    fn forgetting_bytes_that_are_already_gone_is_not_a_failure() {
        let scratch = scratch();
        let blob = store_bytes(scratch.path(), b"transient").expect("send");

        forget_blob(scratch.path(), &blob.hash).expect("first sweep");
        forget_blob(scratch.path(), &blob.hash).expect("回收会重复扫到同一份字节");

        assert!(
            !blob_path(scratch.path(), &blob.hash)
                .expect("path")
                .exists()
        );
    }

    #[test]
    fn staging_does_not_keep_what_it_handed_over() {
        let scratch = scratch();

        store_bytes(scratch.path(), b"handed over").expect("send");

        let staging = scratch.path().join(super::STAGING_DIRECTORY);
        let leftovers = fs::read_dir(&staging).expect("staging directory").count();

        assert_eq!(leftovers, 0, "改名成功之后暂存目录必须是空的");
    }
}

#[cfg(test)]
mod integrity_tests {
    use super::{BlobError, blob_path, read_blob, store_bytes};
    use std::error::Error;

    type TestResult = Result<(), Box<dyn Error>>;

    #[test]
    fn equal_length_corruption_is_detected_and_repaired() -> TestResult {
        let directory = tempfile::tempdir()?;
        let saved = store_bytes(directory.path(), b"valid")?;
        let target = blob_path(directory.path(), &saved.hash)?;
        std::fs::write(target, b"wrong")?;
        assert!(matches!(
            read_blob(directory.path(), &saved.hash),
            Err(BlobError::Integrity)
        ));
        let repaired = store_bytes(directory.path(), b"valid")?;
        assert_eq!(saved.hash, repaired.hash);
        assert_eq!(read_blob(directory.path(), &saved.hash)?, b"valid");
        Ok(())
    }

    #[test]
    fn a_directory_is_not_treated_as_an_existing_blob() -> TestResult {
        let directory = tempfile::tempdir()?;
        let saved = store_bytes(directory.path(), b"valid")?;
        let target = blob_path(directory.path(), &saved.hash)?;
        std::fs::remove_file(&target)?;
        std::fs::create_dir(&target)?;
        assert!(store_bytes(directory.path(), b"valid").is_err());
        assert!(target.is_dir());
        Ok(())
    }

    #[test]
    fn concurrent_writers_keep_one_verified_value() -> TestResult {
        let directory = tempfile::tempdir()?;
        let results = std::thread::scope(|scope| {
            let mut tasks = Vec::new();
            for _ in 0..8 {
                let root = directory.path();
                tasks.push(scope.spawn(move || store_bytes(root, b"concurrent")));
            }
            tasks
                .into_iter()
                .map(std::thread::ScopedJoinHandle::join)
                .collect::<Vec<_>>()
        });
        let mut identity = None;
        for result in results {
            let saved = result.map_err(|_| std::io::Error::other("writer panicked"))??;
            if let Some(expected) = &identity {
                assert_eq!(expected, &saved.hash);
            }
            assert_eq!(read_blob(directory.path(), &saved.hash)?, b"concurrent");
            identity = Some(saved.hash);
        }
        assert_eq!(std::fs::read_dir(directory.path().join("tmp"))?.count(), 0);
        Ok(())
    }
}
