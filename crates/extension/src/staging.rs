use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use uuid::Uuid;

use crate::error::{ExtensionError, Result};
use crate::layout::is_safe_segment;

/// 一份解到暂存区、还没被认领的插件。
#[derive(Debug)]
pub struct Staging {
    identifier: String,
    root: PathBuf,
}

impl Staging {
    pub fn create(staging_root: &Path) -> Result<Self> {
        let identifier = Uuid::now_v7().to_string();
        let root = staging_root.join(&identifier);

        fs::create_dir_all(&root)?;

        Ok(Self { identifier, root })
    }

    pub fn open(staging_root: &Path, identifier: &str) -> Result<Self> {
        if !is_safe_segment(identifier) {
            return Err(ExtensionError::UnsafeSegment);
        }

        let root = staging_root.join(identifier);

        if !root.is_dir() {
            return Err(ExtensionError::StagingMissing);
        }

        Ok(Self {
            identifier: identifier.to_owned(),
            root,
        })
    }

    pub fn identifier(&self) -> &str {
        &self.identifier
    }

    pub fn path(&self) -> &Path {
        &self.root
    }

    /// 顺序是刻意的：旧副本先挪进回收名、新的搬进去、最后才删旧的 —— 先删后搬会留下数据丢失窗口。
    pub fn promote(self, source: &Path, destination: &Path) -> Result<()> {
        if source.strip_prefix(&self.root).is_err() {
            return Err(ExtensionError::UnsafeSegment);
        }

        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }

        let replaced = destination.exists();
        let recycled = self.root.with_extension("replaced");

        if replaced {
            fs::rename(destination, &recycled)?;
        }

        if let Err(cause) = fs::rename(source, destination) {
            if replaced {
                fs::rename(&recycled, destination)?;
            }

            return Err(cause.into());
        }

        if replaced {
            fs::remove_dir_all(&recycled)?;
        }

        self.discard()
    }

    pub fn discard(self) -> Result<()> {
        match fs::remove_dir_all(&self.root) {
            Ok(()) => Ok(()),
            Err(cause) if cause.kind() == ErrorKind::NotFound => Ok(()),
            Err(cause) => Err(cause.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        reason = "a broken fixture assumption must fail the test loudly"
    )]

    use std::fs;

    use tempfile::TempDir;

    use super::Staging;

    #[test]
    fn an_unsafe_identifier_never_opens() {
        let root = TempDir::new().expect("temporary directory");

        assert!(Staging::open(root.path(), "../elsewhere").is_err());
    }

    #[test]
    fn promoting_over_an_existing_copy_replaces_it() {
        let root = TempDir::new().expect("temporary directory");
        let staging_root = root.path().join(".staging");
        let destination = root.path().join("demo");

        fs::create_dir_all(&destination).expect("existing copy");
        fs::write(destination.join("kimi.plugin.json"), "old").expect("old manifest");

        let staging = Staging::create(&staging_root).expect("a staging directory");
        let source = staging.path().to_path_buf();

        fs::write(source.join("kimi.plugin.json"), "new").expect("new manifest");
        staging.promote(&source, &destination).expect("promotion");

        assert_eq!(
            fs::read_to_string(destination.join("kimi.plugin.json")).expect("a manifest"),
            "new"
        );
    }

    #[test]
    fn a_nested_root_can_be_promoted_on_its_own() {
        let root = TempDir::new().expect("temporary directory");
        let staging_root = root.path().join(".staging");
        let destination = root.path().join("demo");

        let staging = Staging::create(&staging_root).expect("a staging directory");
        let nested = staging.path().join("demo-main");

        fs::create_dir_all(&nested).expect("nested directory");
        fs::write(nested.join("kimi.plugin.json"), "nested").expect("manifest");

        let identifier = staging.identifier().to_owned();

        staging.promote(&nested, &destination).expect("promotion");

        assert!(destination.join("kimi.plugin.json").is_file());
        assert!(!staging_root.join(identifier).exists());
    }
}
