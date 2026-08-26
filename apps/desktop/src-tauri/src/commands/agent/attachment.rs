//! 图片的两条路：进去和出来。
//!
//! 进去是一句话带的图片落盘、过继进交付会话、交还给协议；出来是打开一条旧对话时
//! 把存着的字节装回交付注册表。

use crate::asset_protocol::{
    AssetProtocolError, AssetProtocolRegistry, AssetSessionSnapshotEntry, asset_protocol_url,
};
use crate::attachments::{blob_path, store_bytes};
use crate::error::{Error, Result};
use crate::local_index::{LocalIndex, on_index, persistence};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use poietica_agent_persistence_native::ThreadAttachment;
use poietica_agent_runtime_native::PromptAttachment;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{State, async_runtime};
use uuid::Uuid;

use super::dto::AgentPromptAsset;
use super::runtime::AgentRuntime;
use super::{IMAGE_TOO_LARGE, NO_READ, NO_SUCH_ASSET};

/// 一句话里的图片落定之后的两份东西。
///
/// 同一批字节，两个去处，一次解码：协议要 base64 与地址那一份，账本只要摘要。
/// 地址此前另立一个平行的 Vec，靠下标与前两者对齐 —— 三条平行序列，谁错位都
/// 不会有人报错。现在它长在 PromptAttachment 上，一项一张图。
pub(super) struct Kept {
    /// 原样交给协议的那一份，每一项带着它自己的地址。
    pub(super) carried: Vec<PromptAttachment>,
    /// 记进账本的那些行。
    pub(super) ledger: Vec<ThreadAttachment>,
}

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

/// 一句话带的图片：落盘、过继进这条对话的交付会话，再交还给协议。
///
/// 字节从输入框那条资产会话搬过来，搬的是 Arc 不是内存（见 adopt）。它们在
/// 用户放手的那一刻就已经在这个进程里了，所以这个函数不再解码任何东西 ——
/// 此前它的第一件事是 `BASE64.decode`，而那份 base64 是渲染层先把文件读进
/// webview、编码、跨 IPC 送过来的：一次读、一次编码、一次比原文大三分之一的
/// 传输、一次解码，四份代价，只为把本机的一个文件交给本机的一个进程。
///
/// 编码没有消失，它换了一侧：ACP 的 image content block 只认 base64，而 agent
/// 是另一个进程。现在它发生在字节所在的这一侧，不再往返。
///
/// 整段仍在阻塞执行器上。落盘、SHA-256 与 base64 编码都要过一遍全部字节，
/// 单张最大三十二兆，而这段代码一个 await 都没有 —— 与 commands/asset.rs 把
/// 摘要挪走是同一条判据。
///
/// 账本行仍然不在这里写：那要拿库的锁，而这里拿的是文件系统。一个函数一件事。
pub(super) async fn keep_bytes(
    root: PathBuf,
    assets: AssetProtocolRegistry,
    session: String,
    attached: Vec<AgentPromptAsset>,
) -> Result<Kept> {
    if attached.is_empty() {
        return Ok(Kept {
            carried: Vec::new(),
            ledger: Vec::new(),
        });
    }

    async_runtime::spawn_blocking(move || {
        opened_session(&assets, &session)?;

        let mut carried = Vec::with_capacity(attached.len());
        let mut ledger = Vec::with_capacity(attached.len());
        for reference in attached {
            /* 取不到就不发。这一句带的图已经不在了，而静默少发一张比失败更坏：
            对面收到一句没有附件的话，屏幕上什么都不会说。 */
            let (mime, bytes) = assets
                .adopt(&reference.session_token, &reference.asset_token, &session)
                .map_err(asset)?
                .ok_or_else(|| Error::NotFound(NO_SUCH_ASSET.to_owned()))?;

            let blob = store_bytes(&root, &bytes)?;

            /* 地址先算：下一句把摘要交给账本，它就不再属于这里。 */
            let url = asset_protocol_url(&session, &blob.hash).map_err(asset)?;

            let prompt = if mime.starts_with("image/") {
                PromptAttachment::Image {
                    data: BASE64.encode(bytes.as_slice()),
                    mime_type: mime.clone(),
                    url: url.clone(),
                }
            } else if mime == "text/plain" {
                let text = std::str::from_utf8(bytes.as_slice())
                    .map_err(|_| Error::Validation("text attachments must be UTF-8".to_owned()))?
                    .to_owned();
                PromptAttachment::Text {
                    text,
                    url: url.clone(),
                }
            } else {
                return Err(Error::Validation(format!(
                    "unsupported prompt attachment type: {mime}"
                )));
            };

            ledger.push(ThreadAttachment {
                hash: blob.hash,
                mime: mime.clone(),
                byte_size: i64::try_from(blob.byte_size)
                    .map_err(|_overflow| Error::Validation(IMAGE_TOO_LARGE.to_owned()))?,
            });

            carried.push(prompt);
        }

        Ok(Kept { carried, ledger })
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
    let ledger = on_index(index, move |store| {
        store.attachments_of(thread_id).map_err(persistence)
    })
    .await?;

    let session = thread_id.to_string();

    /* 账本空了也要走完这一趟：上一次铺下的那一份得撤掉，而"撤掉"现在就是
    "换成一条空的"。此前这里提前 return，撤除靠的是函数开头那一次单独的
    remove_session —— 两条返回路径,两处撤除时机,而它们必须永远一致。 */

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

    /* 真正铺进去的那些。缺字节的那几张不在里面，所以也不该出现在答复里 ——
    交出一条取不到东西的 URL，屏幕上就是一个破图标。 */
    /* 撤旧与铺新在注册表的同一次写锁里完成。此前是"函数开头 remove_session、
    函数末尾 restore_session"，中间隔着一次库读和一整趟磁盘读：那段时间这条
    会话在注册表里不存在，而这条命令的重入是常态（Ctrl+R、第二个窗口）。旧
    页面上还挂着的 <img> 在那一瞬取到 404，协议这一侧没有重试，破图标就留下
    来了。 */
    /* 缺字节的那几张不在 entries 里：它们的地址仍留在帧上，取不到东西，屏幕上
    就是一个破图标。那是诚实的 —— 那张图真的没了，而这条对话其余部分照旧打开。 */
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
