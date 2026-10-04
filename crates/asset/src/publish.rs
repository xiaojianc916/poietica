//! 助手产物的发布：字节落进发布根，交回一条重启后仍作数的地址。
//!
//! 与附件根分开是刻意的：附件根归账本（thread_attachments），删一条对话就会回收
//! 没人引用的那一份；发布根只按摘要去重，没有第二条引用账，混进会被回收的目录里
//! 迟早被一条无关的删除带走。

use std::path::Path;

use thiserror::Error;

use crate::blob::{BlobError, store_bytes};
use crate::delivery::{PUBLISHED_TOKEN, asset_protocol_url};
use crate::formats::{classify, is_image_content_type};
use crate::identity::{AssetProtocolError, MAX_ASSET_BYTES};

#[derive(Debug, Error)]
pub enum PublishError {
    #[error(transparent)]
    Protocol(#[from] AssetProtocolError),
    #[error(transparent)]
    Blob(#[from] BlobError),
    /// 只收图片：正文里的 <img> 是唯一的用途，别的东西没有可渲染的形状。
    #[error("the published asset is not an image")]
    NotAnImage,
    #[error("the published asset exceeds the size limit")]
    TooLarge,
}

/// 发布一份图片字节，交回资产协议地址。
///
/// 地址里的摘要就是内容寻址的键，所以同内容反复发布只占一份文件、也只产出一条地址。
///
/// # Errors
///
/// 非图片、超过 `MAX_ASSET_BYTES`、或落盘失败。
pub fn publish_image(root: &Path, bytes: &[u8]) -> Result<String, PublishError> {
    if bytes.len() > MAX_ASSET_BYTES {
        return Err(PublishError::TooLarge);
    }

    if !is_image_content_type(classify(bytes)) {
        return Err(PublishError::NotAnImage);
    }

    let blob = store_bytes(root, bytes)?;

    Ok(asset_protocol_url(PUBLISHED_TOKEN, &blob.hash)?)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, reason = "a broken fixture must fail loudly")]

    use super::{PublishError, publish_image};
    use crate::blob::read_blob;
    use tempfile::TempDir;

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

    fn scratch() -> TempDir {
        TempDir::new().expect("scratch directory")
    }

    /// 发布的意义就在这里：进程再起一次，地址还认得出、字节还在。
    #[test]
    fn a_published_image_outlives_the_process_that_published_it() {
        let root = scratch();
        let url = publish_image(root.path(), PNG).expect("a png");
        let hash = url
            .rsplit('/')
            .next()
            .expect("the address ends in a digest");

        assert_eq!(url, format!("poietica-asset://asset/published/{hash}"));
        assert_eq!(read_blob(root.path(), hash).expect("the bytes"), PNG);
    }

    #[test]
    fn the_same_bytes_publish_to_one_address() {
        let root = scratch();

        assert_eq!(
            publish_image(root.path(), PNG).expect("first"),
            publish_image(root.path(), PNG).expect("second")
        );
    }

    #[test]
    fn anything_that_is_not_an_image_is_refused() {
        let root = scratch();

        assert!(matches!(
            publish_image(root.path(), b"plain text"),
            Err(PublishError::NotAnImage)
        ));
    }
}
