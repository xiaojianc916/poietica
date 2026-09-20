//! 附件字节：进（落盘、过继、交引用）与出（装回交付注册表）；协议载荷由 gateway 的 materialise 成形，这里不碰。

use crate::asset_protocol::{AssetProtocolError, AssetProtocolRegistry, AssetSessionSnapshotEntry};
use crate::error::{Error, Result};
use crate::ledger::LocalIndex;
use poietica_asset::blob::{blob_path, store_bytes};
use poietica_ledger::execution::read_index;
use poietica_ledger::index::ThreadAttachment;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{State, async_runtime};
use uuid::Uuid;

use super::AgentRuntime;
use super::dto::AgentPromptAsset;
use super::{IMAGE_TOO_LARGE, NO_READ, NO_SUCH_ASSET};

/// DuplicateAsset 不是错误：同一条对话第二句带图时会话必然已开着。
fn opened_session(assets: &AssetProtocolRegistry, session: &str) -> Result<()> {
    match assets.open_session(session) {
        Ok(()) | Err(AssetProtocolError::DuplicateAsset) => Ok(()),
        Err(error) => Err(asset(error)),
    }
}

/// 落盘并过继进交付会话、交还引用；整段留在阻塞执行器上（落盘与摘要都要过全部字节），账本行不在这里写。
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

/// 交付会话的令牌是对话 id 而非 ACP 的 sessionId：这些 URL 必须在重启之后仍指向同一张图。
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

    /* 账本空了也要走完：上一次铺下的那一份得被换成空的一批。 */

    /* 按摘要去重：同一张图挂在两轮是常事，replace_session 收到重复摘要会把整批拒掉。 */
    let mut seen = HashSet::new();
    let mut wanted = Vec::new();

    for attachment in &ledger {
        if seen.insert(attachment.hash.clone()) {
            wanted.push((attachment.hash.clone(), attachment.mime.clone()));
        }
    }

    let root = state.attachments().clone();

    let entries = async_runtime::spawn_blocking(move || {
        let mut entries = Vec::with_capacity(wanted.len());

        for (hash, mime) in wanted {
            let path = blob_path(&root, &hash)?;

            let bytes = match std::fs::read(&path) {
                Ok(bytes) => bytes,
                /* 字节缺失（手动清过目录、同步软件吞文件）只跳过该张，不挡整条对话打开。 */
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    log::warn!("an attachment's bytes are missing: {hash}");
                    continue;
                }
                Err(error) => return Err(Error::Io(error)),
            };

            /* 字节刚从磁盘读回，进程里无人验过其身份，verify 在此重付一次摘要。 */
            match AssetSessionSnapshotEntry::verify(hash.clone(), mime, Arc::new(bytes)) {
                Ok(entry) => entries.push(entry),
                /* 门口现已挡住的附件类型，迁移前存下的还在账本里：跳过并记日志。 */
                Err(error) => {
                    log::warn!("an attachment cannot be delivered: {hash} {error:?}");
                }
            }
        }

        Ok::<_, Error>(entries)
    })
    .await
    .map_err(|_dropped| Error::Internal(NO_READ.to_owned()))??;

    /* 撤旧与铺新在注册表的同一次写锁里完成（replace_session 原子换）：重入是常态，两次写锁之间旧页面挂着的图会取到 404。 */
    assets.replace_session(&session, entries).map_err(asset)?;

    Ok(())
}

fn asset(error: AssetProtocolError) -> Error {
    log::error!("an attachment could not be delivered: {error:?}");

    Error::Asset("an attachment could not be delivered".to_owned())
}
