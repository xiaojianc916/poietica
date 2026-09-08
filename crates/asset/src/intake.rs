use crate::content::AssetSessionSnapshotEntry;
use crate::delivery::asset_protocol_url;
use crate::identity::{AssetProtocolError, MAX_ASSET_BYTES, MAX_REGISTRY_BYTES};
use crate::registry::AssetProtocolRegistry;
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read};
use std::path::Path;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AssetIntakeError {
    #[error(transparent)]
    Protocol(#[from] AssetProtocolError),
    #[error("attachment file could not be read: {0}")]
    Read(#[from] io::Error),
}

#[derive(Debug)]
pub struct ImportedAsset {
    pub content_hash: String,
    pub source: String,
    pub byte_length: u32,
    pub content_type: String,
}

pub fn import_bytes(
    registry: &AssetProtocolRegistry,
    session: &str,
    bytes: Vec<u8>,
) -> Result<ImportedAsset, AssetIntakeError> {
    let entry = AssetSessionSnapshotEntry::from_bytes(bytes)?;
    let mut receipts = admit(registry, session, vec![entry])?;
    receipts
        .pop()
        .ok_or_else(|| AssetProtocolError::Internal.into())
}

pub fn import_files(
    registry: &AssetProtocolRegistry,
    session: &str,
    paths: &[String],
) -> Result<Vec<ImportedAsset>, AssetIntakeError> {
    let mut unique = HashMap::<String, AssetSessionSnapshotEntry>::new();
    let mut prepared = Vec::with_capacity(paths.len());
    let mut unique_bytes = 0_usize;
    for name in paths {
        let file = File::open(Path::new(name))?;
        if !file.metadata()?.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "attachment is not a regular file",
            )
            .into());
        }
        let mut bytes = Vec::new();
        file.take(MAX_ASSET_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        let entry = AssetSessionSnapshotEntry::from_bytes(bytes)?;
        if let Some(existing) = unique.get(entry.content_hash()) {
            prepared.push(existing.clone());
        } else {
            unique_bytes = unique_bytes
                .checked_add(entry.bytes().len())
                .ok_or(AssetProtocolError::RegistryBudgetExceeded)?;
            if unique_bytes > MAX_REGISTRY_BYTES {
                return Err(AssetProtocolError::RegistryBudgetExceeded.into());
            }
            unique.insert(entry.content_hash().to_owned(), entry.clone());
            prepared.push(entry);
        }
    }
    admit(registry, session, prepared)
}

fn admit(
    registry: &AssetProtocolRegistry,
    session: &str,
    entries: Vec<AssetSessionSnapshotEntry>,
) -> Result<Vec<ImportedAsset>, AssetIntakeError> {
    let receipts = entries
        .iter()
        .map(|entry| {
            Ok(ImportedAsset {
                content_hash: entry.content_hash().to_owned(),
                source: asset_protocol_url(session, entry.content_hash())?,
                byte_length: u32::try_from(entry.bytes().len())
                    .map_err(|_| AssetProtocolError::AssetTooLarge)?,
                content_type: entry.content_type().to_owned(),
            })
        })
        .collect::<Result<Vec<_>, AssetProtocolError>>()?;
    registry.register(session, entries)?;
    Ok(receipts)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, reason = "fixture failures must fail the test")]
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn a_bad_file_leaves_the_entire_batch_unregistered() {
        let directory = TempDir::new().expect("directory");
        let valid = directory.path().join("valid.txt");
        let missing = directory.path().join("missing.txt");
        fs::write(&valid, "valid attachment").expect("fixture");
        let registry = AssetProtocolRegistry::default();
        registry.open_session("composer").expect("session");
        let result = import_files(
            &registry,
            "composer",
            &[
                valid.to_string_lossy().into_owned(),
                missing.to_string_lossy().into_owned(),
            ],
        );
        assert!(result.is_err());
        assert_eq!(registry.total_bytes(), 0);
    }

    #[test]
    fn duplicate_file_receipts_have_independent_references() {
        let directory = TempDir::new().expect("directory");
        let file = directory.path().join("same.txt");
        fs::write(&file, "shared").expect("fixture");
        let name = file.to_string_lossy().into_owned();
        let registry = AssetProtocolRegistry::default();
        registry.open_session("composer").expect("session");
        let receipts = import_files(&registry, "composer", &[name.clone(), name]).expect("import");
        assert_eq!(receipts.len(), 2);
        let hash = &receipts.first().expect("receipt").content_hash;
        assert_eq!(registry.total_bytes(), 6);
        registry.remove("composer", hash).expect("first reference");
        assert!(registry.deliver("composer", hash).is_ok());
        registry.remove("composer", hash).expect("last reference");
        assert_eq!(registry.total_bytes(), 0);
    }
}
