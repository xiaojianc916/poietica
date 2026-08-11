//! 附件的字节住在哪里 —— 一个内容寻址的本地 blob 仓。
//!
//! 这一层此前根本不存在。渲染层把图片读成 base64 的 `data:` URL 直接塞进
//! 时间线（`prompt-attachments.ts`：「不落盘，不建 URL，不经过任何注册表」），
//! 于是重启之后账本指着的字节谁也拿不出来。
//!
//! 三层的分工是清楚的，各自只做一件事：
//!
//! - 账本（`poietica_agent_persistence_native::attachments`）：哪条对话的第几轮
//!   挂着哪个 hash。它不碰字节。
//! - 字节（这里）：hash 到文件的映射，去重、原子落盘、遗忘。它不知道对话。
//! - 送达（`asset_protocol`）：`poietica-asset://` 的 range 与缓存头。
//!
//! 内容寻址的意思是：文件名就是内容的 sha256。同一张图发十次只占一份字节，
//! 而账本里是十条链接 —— 这正是账本用 hash 而不是文件名做外键的原因。
//!
//! 两个方向的顺序是刻意的，不能倒过来：
//!
//! - 存：先写字节，再写账本行。
//! - 删：先删账本行，再删字节。
//!
//! 两边都让「有字节、没有行」成为唯一可能的中间态，因为那一态会被启动时的
//! 回收（`unreferenced_attachments`）自动清掉。反过来的「有行、没有字节」是
//! 界面上的破图，没有任何人能修。

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::{Error, Result};

/// 半成品的暂存处，与散列目录同级。
///
/// 名字不是两位十六进制，所以它和散列目录天然区分得开。
const STAGING_DIRECTORY: &str = "tmp";

/// 一份已经躺在磁盘上的字节。
#[derive(Clone, Debug)]
pub(crate) struct Blob {
    /// 内容的 sha256，小写十六进制。它同时就是文件名。
    pub hash: String,
    /// 字节数。账本要存它，界面要用它显示大小。
    pub byte_size: u64,
}

/// 这个字符串是不是一个 sha256 摘要。
///
/// 路径是从 hash 拼出来的，所以这不是格式洁癖，而是唯一挡住 `..` 的地方：
/// 账本里的值终究来自某一次写入，而写入的上游是渲染层。
#[must_use]
pub(crate) fn is_content_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

/// 这个 hash 对应的字节应该在哪个文件。
///
/// 只做映射，不保证文件存在。
///
/// # Errors
///
/// hash 不是 sha256 摘要时返回校验错误。
pub(crate) fn blob_path(root: &Path, hash: &str) -> Result<PathBuf> {
    let shard = hash
        .get(0..2)
        .filter(|_| is_content_hash(hash))
        .ok_or_else(|| Error::Validation("attachment hash is not a sha256 digest".into()))?;

    Ok(root.join(shard).join(hash))
}

/// 把这些字节存进仓里，返回它们的身份。
///
/// 已经存过的同一份字节不会被再写一遍 —— 内容寻址的仓里，「已经在了」就是
/// 成功，不是冲突。
///
/// 落盘走暂存加改名：直接往目标路径写，进程在写到一半时被杀，磁盘上就会留下
/// 一个名字是 sha256、内容却不是那份字节的文件。内容寻址的仓一旦被这样污染，
/// 之后每一次读都是错的，而且永远不会自愈。同一分区上的改名是原子的。
///
/// 这个函数是 CPU 与磁盘密集的（摘要要过一遍全部字节），调用方必须把它放在
/// 阻塞执行器上，不要占住命令的 worker —— `commands/asset.rs` 里的
/// `spawn_blocking` 就是为同一个理由存在的。
///
/// # Errors
///
/// 目录无法创建、暂存文件无法写入、或改名失败且目标仍不存在时返回错误。
pub(crate) fn store_bytes(root: &Path, bytes: &[u8]) -> Result<Blob> {
    let hash = hex::encode(Sha256::digest(bytes));
    let byte_size = u64::try_from(bytes.len())
        .map_err(|_ignored| Error::Asset("attachment length overflow".into()))?;
    let path = blob_path(root, &hash)?;

    /*
     * 同样的 hash 意味着同样的字节，所以已经在仓里就直接认账。这里顺手校
     * 一下长度：长度对不上说明磁盘上那一份是坏的（比如上一次落盘被中断，
     * 或者外部工具动过），那就当它不存在，重写一遍盖掉。
     */
    if fs::metadata(&path).is_ok_and(|found| found.len() == byte_size) {
        return Ok(Blob { hash, byte_size });
    }

    let shard = path
        .parent()
        .ok_or_else(|| Error::Internal("attachment path has no shard".into()))?;

    fs::create_dir_all(shard)?;

    let staging = root.join(STAGING_DIRECTORY);

    fs::create_dir_all(&staging)?;

    let pending = staging.join(Uuid::now_v7().simple().to_string());

    fs::write(&pending, bytes)?;

    if let Err(error) = fs::rename(&pending, &path) {
        let _ignored = fs::remove_file(&pending);

        /*
         * Windows 上改名盖不掉已存在的文件。走到这里说明另一次写入抢先把
         * 同一份字节放好了 —— 内容一样，那就是成功。
         */
        if !path.is_file() {
            return Err(error.into());
        }
    }

    Ok(Blob { hash, byte_size })
}

/// 忘掉这份字节。
///
/// 已经不在了也是成功：回收是在账本删完之后跑的，同一份字节被扫到两次是
/// 正常的，不该让第二次报错。
///
/// # Errors
///
/// hash 不合法、或删除被系统拒绝时返回错误。
pub(crate) fn forget_blob(root: &Path, hash: &str) -> Result<()> {
    let path = blob_path(root, hash)?;

    match fs::remove_file(&path) {
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
    /// 这里此前手写了二十行的 Scratch，理由写着「不引 tempfile：这个 crate 的
    /// 测试目前没有它」。那句话是假的：tempfile 一直在 Cargo.toml 的
    /// dependencies 段里，commands/agent/thread.rs 用它替换 Kimi 的
    /// state.json，而普通依赖对同一个 crate 的测试本来就可见 —— 一个 dev 依赖
    /// 都不需要。作者以为它不在，它却就在，于是那二十行把 TempDir 已经做好的
    /// 事重写了一遍：开一个没人用过的目录，drop 时抹掉。
    ///
    /// 前缀是留着的：TempDir 默认叫 .tmpXXXXXX，谁都认不出那是谁掉的。测试进程
    /// 被硬杀时 drop 不跑，残留得能一眼归到我们头上。
    ///
    /// 全限定写法跟着 thread.rs 走，那边也没有为 tempfile 立一行 use。
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

        assert!(!blob_path(scratch.path(), &blob.hash).expect("path").exists());
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
