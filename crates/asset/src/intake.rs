use crate::blob::store_bytes;
use crate::content::AssetSessionSnapshotEntry;
use crate::delivery::asset_protocol_url;
use crate::formats::{classify, digest_hex, is_image_content_type};
use crate::identity::{AssetProtocolError, MAX_ASSET_BYTES};
use crate::registry::AssetProtocolRegistry;
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read};
use std::path::Path;
use std::sync::Arc;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AssetIntakeError {
    #[error(transparent)]
    Protocol(#[from] AssetProtocolError),
    #[error(transparent)]
    Blob(#[from] crate::blob::BlobError),
    #[error("attachment file could not be read: {0}")]
    Read(#[from] io::Error),
}

/// 进门之后的两条路：图片进内存注册表走预览，其它文件落盘暂存、原样投递。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ImportedKind {
    Image,
    File,
}

impl ImportedKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::File => "file",
        }
    }
}

#[derive(Debug)]
pub struct ImportedAsset {
    pub kind: ImportedKind,
    pub content_hash: String,
    /// 图片是资产协议地址（<img src> 直接用）；通用文件为空字符串，它没有预览。
    pub source: String,
    pub byte_length: u32,
    pub content_type: String,
}

/// 一份读进来的字节，以及它该走的那一条路。
#[derive(Clone)]
struct Prepared {
    content_type: String,
    // 与注册表条目共享同一份进门分配；同款 allow 见 content.rs 顶部。
    #[allow(
        clippy::rc_buffer,
        reason = "shares the ingestion allocation with registry entries"
    )]
    bytes: Arc<Vec<u8>>,
    /// 图片在注册表里的成形条目；通用文件为 None。
    entry: Option<AssetSessionSnapshotEntry>,
}

impl Prepared {
    fn kind(&self) -> ImportedKind {
        if self.entry.is_some() {
            ImportedKind::Image
        } else {
            ImportedKind::File
        }
    }
}

/// 剪贴板来的字节：只可能是图片，所以没有暂存根可落。
///
/// 判据在这里明写一次，不靠调用方自觉：通用文件要往暂存根落盘，而这条路的字节
/// 没有根 —— 放一个文本进来就会被 `commit` 拒掉，而不是拿到一条指向假路径的收据。
pub fn import_bytes(
    registry: &AssetProtocolRegistry,
    session: &str,
    bytes: Vec<u8>,
) -> Result<ImportedAsset, AssetIntakeError> {
    let entry = AssetSessionSnapshotEntry::from_bytes(bytes)?;
    if !is_image_content_type(entry.content_type()) {
        return Err(AssetProtocolError::UnsupportedContentType.into());
    }
    let prepared = Prepared {
        content_type: entry.content_type().to_owned(),
        bytes: Arc::clone(entry.bytes()),
        entry: Some(entry),
    };
    let mut receipts = commit(registry, session, None, &[prepared])?;
    receipts
        .pop()
        .ok_or_else(|| AssetProtocolError::Internal.into())
}

///
/// 读盘与判定全部完成之后才提交：一个路径打不开，整批不进注册表也不落盘。
///
/// 图片进内存注册表（与剪贴板同一条路）；其余字节按内容摘要落进暂存根
/// （tmp 下，启动对账时清），发送时再搬进附件根。
pub fn import_files(
    registry: &AssetProtocolRegistry,
    session: &str,
    staging_root: &Path,
    paths: &[String],
) -> Result<Vec<ImportedAsset>, AssetIntakeError> {
    let mut unique: HashMap<String, Prepared> = HashMap::new();
    let mut prepared: Vec<Prepared> = Vec::with_capacity(paths.len());

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
        if bytes.len() > MAX_ASSET_BYTES {
            return Err(AssetProtocolError::AssetTooLarge.into());
        }

        let content_type = classify(&bytes);
        // 图片成形时消费字节、Arc 从条目里取回；通用文件直接把字节包进 Arc。
        let (entry, bytes_arc): (Option<AssetSessionSnapshotEntry>, Arc<Vec<u8>>) =
            if is_image_content_type(content_type) {
                // 图片的内容类型必须在可投递清单里：from_bytes 同时把大小与类型守住。
                let formed = AssetSessionSnapshotEntry::from_bytes(bytes)?;
                let shared = Arc::clone(formed.bytes());
                (Some(formed), shared)
            } else {
                (None, Arc::new(bytes))
            };
        let made = Prepared {
            content_type: content_type.to_owned(),
            bytes: bytes_arc,
            entry,
        };

        /* 同内容只留一份：几份副本共用一个 Arc，峰值内存才不被路径数放大。 */
        let hash = digest_hex(&made.bytes);
        if let Some(existing) = unique.get(&hash) {
            prepared.push(existing.clone());
        } else {
            unique.insert(hash, made.clone());
            prepared.push(made);
        }
    }

    commit(registry, session, Some(staging_root), &prepared)
}

/// 先过注册表（预算拒绝时整批不落盘），再把通用文件写进暂存根。
///
/// 暂存根是 Option：剪贴板那条路根本没有暂存根，而「没有根却要落一个通用文件」
/// 必须在这里被挡下 —— 拼一个空路径出去就是往进程当前目录里写。
fn commit(
    registry: &AssetProtocolRegistry,
    session: &str,
    staging_root: Option<&Path>,
    prepared: &[Prepared],
) -> Result<Vec<ImportedAsset>, AssetIntakeError> {
    let image_entries: Vec<AssetSessionSnapshotEntry> = prepared
        .iter()
        .filter_map(|item| item.entry.clone())
        .collect();
    if !image_entries.is_empty() {
        registry.register(session, image_entries)?;
    }

    let mut receipts = Vec::with_capacity(prepared.len());
    for item in prepared {
        let hash = digest_hex(&item.bytes);
        let byte_length =
            u32::try_from(item.bytes.len()).map_err(|_| AssetProtocolError::AssetTooLarge)?;
        let source = match item.kind() {
            ImportedKind::Image => asset_protocol_url(session, &hash)?,
            ImportedKind::File => {
                let root = staging_root.ok_or(AssetProtocolError::UnsupportedContentType)?;
                store_bytes(root, &item.bytes)?;
                String::new()
            }
        };
        receipts.push(ImportedAsset {
            kind: item.kind(),
            content_hash: hash,
            source,
            byte_length,
            content_type: item.content_type.clone(),
        });
    }
    Ok(receipts)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, reason = "fixture failures must fail the test")]
    use super::*;
    use crate::blob::blob_path;
    use std::fs;
    use tempfile::TempDir;

    fn png_bytes() -> Vec<u8> {
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR".to_vec()
    }

    #[test]
    fn a_bad_file_leaves_the_entire_batch_uncommitted() {
        let directory = TempDir::new().expect("directory");
        let staging = TempDir::new().expect("staging");
        let valid = directory.path().join("valid.txt");
        let missing = directory.path().join("missing.txt");
        fs::write(&valid, "valid attachment").expect("fixture");
        let registry = AssetProtocolRegistry::default();
        registry.open_session("composer").expect("session");
        let result = import_files(
            &registry,
            "composer",
            staging.path(),
            &[
                valid.to_string_lossy().into_owned(),
                missing.to_string_lossy().into_owned(),
            ],
        );
        assert!(result.is_err());
        assert_eq!(registry.total_bytes(), 0);
        assert_eq!(
            fs::read_dir(staging.path()).expect("dir").count(),
            0,
            "失败的整批不许在暂存根留下字节"
        );
    }

    #[test]
    fn duplicate_image_receipts_have_independent_references() {
        let directory = TempDir::new().expect("directory");
        let staging = TempDir::new().expect("staging");
        let file = directory.path().join("same.png");
        fs::write(&file, png_bytes()).expect("fixture");
        let name = file.to_string_lossy().into_owned();
        let registry = AssetProtocolRegistry::default();
        registry.open_session("composer").expect("session");
        let receipts = import_files(&registry, "composer", staging.path(), &[name.clone(), name])
            .expect("import");
        assert_eq!(receipts.len(), 2);
        assert!(receipts.iter().all(|item| item.kind == ImportedKind::Image));
        let hash = &receipts.first().expect("receipt").content_hash;
        registry.remove("composer", hash).expect("first reference");
        assert!(registry.deliver("composer", hash).is_ok());
        registry.remove("composer", hash).expect("last reference");
        assert_eq!(registry.total_bytes(), 0);
    }

    #[test]
    fn a_pasted_text_body_is_refused_rather_than_given_a_path_that_does_not_exist() {
        let registry = AssetProtocolRegistry::default();
        registry.open_session("composer").expect("session");
        /* 剪贴板那条路没有暂存根：放文本进来就会拿到一条指向空路径的收据。 */
        assert!(import_bytes(&registry, "composer", b"just some text".to_vec()).is_err());
        assert_eq!(registry.total_bytes(), 0);
    }

    #[test]
    fn a_text_file_is_staged_as_a_generic_file_not_inlined() {
        let directory = TempDir::new().expect("directory");
        let staging = TempDir::new().expect("staging");
        let file = directory.path().join("secrets.txt");
        fs::write(&file, "plain text body").expect("fixture");
        let registry = AssetProtocolRegistry::default();
        registry.open_session("composer").expect("session");
        let receipts = import_files(
            &registry,
            "composer",
            staging.path(),
            &[file.to_string_lossy().into_owned()],
        )
        .expect("import");
        let receipt = receipts.first().expect("one receipt");
        assert_eq!(receipt.kind, ImportedKind::File);
        assert_eq!(receipt.content_type, "text/plain");
        assert_eq!(receipt.source, "");
        assert_eq!(registry.total_bytes(), 0, "文本不进内存注册表");
        assert!(
            blob_path(staging.path(), &receipt.content_hash)
                .expect("path")
                .is_file(),
            "通用文件按摘要落在暂存根"
        );
    }

    #[test]
    fn an_unrecognised_binary_is_accepted_as_a_generic_file() {
        let directory = TempDir::new().expect("directory");
        let staging = TempDir::new().expect("staging");
        let file = directory.path().join("bundle.zip");
        fs::write(&file, [0u8, 1, 2, 255, 254, 0, 1]).expect("fixture");
        let registry = AssetProtocolRegistry::default();
        registry.open_session("composer").expect("session");
        let receipts = import_files(
            &registry,
            "composer",
            staging.path(),
            &[file.to_string_lossy().into_owned()],
        )
        .expect("import");
        assert_eq!(
            receipts.first().expect("receipt").content_type,
            "application/octet-stream"
        );
    }
}
