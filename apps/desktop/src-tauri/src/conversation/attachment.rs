//! 附件字节：把一句话带的字节落进附件根，交还账本行。
//!
//! 附件只交「磁盘绝对路径 + 元数据」给 agent（见 gateway.rs 的 materialise）：图片
//! 与通用文件在线上是不同的 content part，但字节都不内联。落盘之后再放掉 composer
//! 注册表里的那一份 —— 进门时的注册只为预览，字节一旦进了附件根就归这条对话。

use crate::asset_protocol::{AssetProtocolError, AssetProtocolRegistry};
use crate::error::{Error, Result};
use poietica_asset::blob::{read_blob, store_bytes};
use poietica_asset::classify;
use poietica_ledger::index::ThreadAttachment;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::async_runtime;

use super::dto::AgentPromptAsset;
use super::{IMAGE_TOO_LARGE, NO_READ};
use crate::asset::AssetKind;

///
/// 落盘并交还引用；整段留在阻塞执行器上（落盘与摘要都要过全部字节），
/// 账本行不在这里写（在账本准入事务里写，见 ledger conversation/mod.rs）。
///
/// 通用文件的字节在 composer 暂存根；图片在 composer 注册表里 —— 进门时的注册
/// 只为预览，字节落进附件根之后就把那一份放掉，否则发过的图会一直占着注册表预算
/// （256MiB 封顶，占满之后新的图就进不来了）。
pub(super) async fn keep_bytes(
    root: PathBuf,
    staging_root: PathBuf,
    assets: AssetProtocolRegistry,
    attached: Vec<AgentPromptAsset>,
) -> Result<Vec<ThreadAttachment>> {
    if attached.is_empty() {
        return Ok(Vec::new());
    }

    async_runtime::spawn_blocking(move || {
        let mut rows = Vec::with_capacity(attached.len());
        for reference in attached {
            let (mime, bytes) = match reference.kind {
                AssetKind::File => {
                    let bytes = read_blob(&staging_root, &reference.asset_token)?;
                    (classify(&bytes).to_owned(), bytes)
                }
                AssetKind::Image => {
                    let delivered = assets
                        .deliver(&reference.session_token, &reference.asset_token)
                        .map_err(asset)?;
                    let mime = delivered.content_type;
                    // 注册表条目与别处共享 Arc，落盘要的是一份独占字节。
                    (
                        mime,
                        Arc::try_unwrap(delivered.bytes).unwrap_or_else(|shared| (*shared).clone()),
                    )
                }
            };

            // 顺序即不变量：字节先落进附件根，再放掉进门的那一份；中间态只会多留一份。
            let blob = store_bytes(&root, &bytes)?;
            release(&assets, &reference);

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

/// 放掉进门时的那一份。
///
/// 通用文件在暂存根上，不进注册表，这里没它的事；图片可能已被用户自己从托盘上
/// 删掉（那时注册表里已经没有它），所以放不掉也不算错误。
fn release(assets: &AssetProtocolRegistry, reference: &AgentPromptAsset) {
    if reference.kind == AssetKind::File {
        return;
    }

    if let Err(error) = assets.remove(&reference.session_token, &reference.asset_token) {
        log::warn!("a sent attachment stayed registered: {error:?}");
    }
}

fn asset(error: AssetProtocolError) -> Error {
    log::error!("an attachment could not be read: {error:?}");

    Error::Asset("an attachment could not be read".to_owned())
}
