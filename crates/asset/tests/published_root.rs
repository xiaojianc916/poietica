//! 发布根与附件根的回路：这两条路各读各的目录，读错根就是拿别人的字节去回答。
#![allow(clippy::expect_used, reason = "a broken fixture must fail loudly")]

use std::path::Path;

use poietica_asset::{PUBLISHED_TOKEN, publish_image};
use tempfile::TempDir;

/// 发布根里能取回发布的字节；同样一份摘要去附件根找，找不到。
#[test]
fn a_published_image_is_only_reachable_under_the_published_root() {
    let published = TempDir::new().expect("published root");
    let attachments = TempDir::new().expect("attachments root");
    let png: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

    let url = publish_image(published.path(), png).expect("a png");
    let hash = url.rsplit('/').next().expect("a digest at the end");

    assert!(
        url.contains(PUBLISHED_TOKEN),
        "the address names its own root: {url}"
    );
    assert_eq!(
        poietica_asset::blob::read_blob(published.path(), hash).expect("published bytes"),
        png
    );
    assert!(
        poietica_asset::blob::read_blob(attachments.path(), hash).is_err(),
        "the attachment root must not answer for a published asset"
    );
}

/// 换个进程读同一份字节：地址不认进程，只认摘要与根。
#[test]
fn the_address_survives_a_fresh_process() {
    let root = TempDir::new().expect("published root");
    let png: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00];

    let url = publish_image(root.path(), png).expect("first run");
    let hash = url.rsplit('/').next().expect("a digest at the end");

    /* 模拟重启：只握着地址与根，重新解析一次。 */
    let reopened = poietica_asset::blob::read_blob(Path::new(root.path()), hash).expect("bytes");

    assert_eq!(reopened, png);
}
