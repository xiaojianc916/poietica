//! 图片的两条路：进去和出来。
//!
//! 进去是一句话带的图片落盘、过继进交付会话、把引用交还准入；出来是打开一条
//! 旧对话时把存着的字节装回交付注册表。
//!
//! 协议载荷不在这里成形：投递时由网关按准入冻结的引用重建（gateway.rs 的
//! materialise），首次投递与重投递走同一条路 —— 这里只落字节、记账、交引用。

use crate::asset_protocol::{AssetProtocolError, AssetProtocolRegistry, AssetSessionSnapshotEntry};
use crate::error::{Error, Result};
use crate::ipc::commands::ledger::LocalIndex;
use poietica_asset::blob::{blob_path, store_bytes};
use poietica_ledger::execution::read_index;
use poietica_ledger::index::ThreadAttachment;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{State, async_runtime};
use uuid::Uuid;

use super::dto::AgentPromptAsset;
use super::runtime::AgentRuntime;
use super::{IMAGE_TOO_LARGE, NO_READ, NO_SUCH_ASSET};

/// 这条对话的交付会话，没有就开一个。
///
/// 注册表用 DuplicateAsset 表示"这条会话已经在了"，而同一条对话上的第二句话
/// 带图时它必然已经开着 —— 那不是错误，是常态。
fn opened_session(assets: &AssetProtocolRegistry, session: &str) -> Result<()> {
    match assets.open_session(session) {
        Ok(()) | Err(AssetProtocolError::DuplicateAsset) => Ok(()),
        Err(error) => Err(asset(error)),
    }
}

/// 一句话带的图片：落盘、过继进这条对话的交付会话，把引用交还给准入。
///
/// 字节搬的是 Arc 不是内存（见 adopt）：用户放手那一刻它们已经在本进程里。
/// 投递时由网关从盘上读回再编码 —— KAP 的 image content block 只认 base64。
/// 落盘与 SHA-256 都要过一遍全部字节，所以整段留在阻塞执行器上。
/// 账本行不在这里写：那要拿库的锁，而这里拿的是文件系统。
pub(super) async fn keep_bytes(
    root: PathBuf,
    assets: AssetProtocolRegistry,
    session: String,
    attached: Vec<AgentPromptAsset>,
) -> Result<Vec<ThreadAttachment>> {
    if attached.is_empty() {
        return Ok(Vec::new());
    }

    async_runtime::spawn_blocking(move || {
        opened_session(&assets, &session)?;

        let mut rows = Vec::with_capacity(attached.len());
        for reference in attached {
            /* 取不到就不发。这一句带的图已经不在了，而静默少发一张比失败更坏：
            对面收到一句没有附件的话，屏幕上什么都不会说。 */
            let (mime, bytes) = assets
                .adopt(&reference.session_token, &reference.asset_token, &session)
                .map_err(asset)?
                .ok_or_else(|| Error::NotFound(NO_SUCH_ASSET.to_owned()))?;

            let blob = store_bytes(&root, &bytes)?;

            rows.push(ThreadAttachment {
                hash: blob.hash,
                byte_size: i64::try_from(blob.byte_size)
                    .map_err(|_overflow| Error::Validation(IMAGE_TOO_LARGE.to_owned()))?,
                mime,
                name: reference.filename,
            });
        }

        Ok(rows)
    })
    .await
    .map_err(|_dropped| Error::Internal(NO_READ.to_owned()))?
}

/// 把这条对话挂着的字节装回交付注册表，并交出可以直接用的 URL。
///
/// 交付会话的令牌是**对话**，不是 ACP 的 sessionId：后者随连接生灭，而这些
/// URL 要在重启之后仍然指向同一张图。
///
/// # Errors
///
/// 账本读不出、字节读不动（缺失除外）、或注册表拒绝这一批时返回错误。
pub(super) async fn deliver_attachments(
    state: &State<'_, AgentRuntime>,
    index: &State<'_, LocalIndex>,
    assets: &State<'_, AssetProtocolRegistry>,
    thread_id: Uuid,
) -> Result<()> {
    let ledger = read_index(index, move |store| {
        store.attachments_of(thread_id).map_err(Error::from)
    })
    .await?;

    let session = thread_id.to_string();

    /* 账本空了也要走完这一趟：上一次铺下的那一份得换成一条空的。 */

    /* 按摘要去重。同一张图挂在两轮上是常事 —— 内容寻址的全部意义就在这里 ——
    而 replace_session 收到两个相同的摘要会把整批拒掉。账本给的是链接行，不是
    字节，两者的条数本来就不相等。 */
    let mut seen = HashSet::new();
    let mut wanted = Vec::new();

    for attachment in &ledger {
        if seen.insert(attachment.hash.clone()) {
            wanted.push((attachment.hash.clone(), attachment.mime.clone()));
        }
    }

    let root = state.attachments.clone();

    let entries = async_runtime::spawn_blocking(move || {
        let mut entries = Vec::with_capacity(wanted.len());

        for (hash, mime) in wanted {
            let path = blob_path(&root, &hash)?;

            let bytes = match std::fs::read(&path) {
                Ok(bytes) => bytes,
                /* 少一张图不该让整条对话打不开。人可以手动清过那个目录，同步
                软件也可能吞掉文件；那时候正确的行为是显示其余的，而不是把这
                条对话变成一个打不开的东西。无主的账下一次回收会扫掉。 */
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    log::warn!("an attachment's bytes are missing: {hash}");
                    continue;
                }
                Err(error) => return Err(Error::Io(error)),
            };

            /* verify 在这里重新付一次摘要：这些字节刚从磁盘读上来，进程里
            没有人对它们的身份验过。文件名就是摘要，所以这一次哈希同时就是一
            次完整性检查。 */
            match AssetSessionSnapshotEntry::verify(hash.clone(), mime, Arc::new(bytes)) {
                Ok(entry) => entries.push(entry),
                /* 门口现在挡着这类附件（见 agent_prompt），但迁移之前存下的那些
                还在账本里。一张交付不了的图此前会让整条对话打不开 —— 与上面缺
                字节那一支同一条规矩：显示其余的，把这一张记进日志。 */
                Err(error) => {
                    log::warn!("an attachment cannot be delivered: {hash} {error:?}");
                }
            }
        }

        Ok::<_, Error>(entries)
    })
    .await
    .map_err(|_dropped| Error::Internal(NO_READ.to_owned()))??;

    /* 撤旧与铺新在注册表的同一次写锁里完成：这条命令的重入是常态，两次写锁之间
    这条会话会短暂不存在，旧页面上还挂着的图片元素就会取到 404。缺字节的那几张
    不在 entries 里 —— 那张图真的没了，这条对话其余部分照旧打开。 */
    assets.replace_session(&session, entries).map_err(asset)?;

    Ok(())
}

/// 交付失败，说给屏幕听的那一句。
///
/// 与 translate 同一条规矩：细节进日志，上屏的是固定文案。这里的细节是注册表
/// 的内部判定（预算、令牌形状、摘要不符），对屏幕前的人没有一句是可行动的。
fn asset(error: AssetProtocolError) -> Error {
    log::error!("an attachment could not be delivered: {error:?}");

    Error::Asset("an attachment could not be delivered".to_owned())
}
