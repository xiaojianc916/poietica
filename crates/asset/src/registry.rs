//! 内容寻址资产的注册表：交付会话、身份校验与预算。
//!
//! 令牌是唯一入口：这里不认文件系统路径，也不认渲染层自报的内容类型。字节
//! 的身份在每一次收下时用摘要付清；交付面只交出已验过身份的那一份。

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use sha2::{Digest, Sha256};

pub const ASSET_PROTOCOL_SCHEME: &str = "poietica-asset";

pub const ASSET_PROTOCOL_HOST: &str = "asset";
const MAX_ASSET_BYTES: usize = 32 * 1024 * 1024;
const MAX_REGISTRY_BYTES: usize = 256 * 1024 * 1024;
const MAX_TOKEN_BYTES: usize = 128;

/// One content-addressed asset whose bytes are known to match their declared
/// SHA-256 identity.
///
/// The fields are private because that guarantee is the whole value of this
/// type. Every construction site has to say how it establishes the guarantee,
/// either by paying for the digest or by naming the check that already did.
///
/// Bytes are held as Arc<Vec<u8>> rather than Arc<[u8]>. Arc stores a refcount
/// ahead of its payload, so `Arc::from(vec)` cannot adopt the Vec's allocation
/// and copies every byte; `Arc::new` boxes the Vec that already exists. The cost
/// is one extra pointer hop per access, not per byte, and nothing here needs

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetSessionSnapshotEntry {
    content_hash: String,
    content_type: String,
    #[allow(
        clippy::rc_buffer,
        reason = "the payload is produced as a Vec and shared read-only; Arc<[u8]> would force an extra copy"
    )]
    bytes: Arc<Vec<u8>>,
}

impl AssetSessionSnapshotEntry {
    /// Builds an entry by hashing the bytes and comparing them to the declared
    /// identity.
    ///
    /// 这是唯一的构造入口：身份保证在这里用一次摘要付清。
    pub fn verify(
        content_hash: String,
        content_type: String,
        #[allow(
            clippy::rc_buffer,
            reason = "the payload is produced as a Vec and shared read-only; Arc<[u8]> would force an extra copy"
        )]
        bytes: Arc<Vec<u8>>,
    ) -> Result<Self, AssetProtocolError> {
        validate_content_hash(&content_hash)?;
        validate_content_type(&content_type)?;

        if hex::encode(Sha256::digest(bytes.as_slice())) != content_hash {
            return Err(AssetProtocolError::InvalidContentHash);
        }

        Ok(Self {
            content_hash,
            content_type,
            bytes,
        })
    }

    #[allow(
        clippy::rc_buffer,
        reason = "the payload is produced as a Vec and shared read-only; Arc<[u8]> would force an extra copy"
    )]
    pub fn bytes(&self) -> &Arc<Vec<u8>> {
        &self.bytes
    }
}

#[derive(Clone, Debug)]
pub struct RegisteredAsset {
    #[allow(
        clippy::rc_buffer,
        reason = "the payload is produced as a Vec and shared read-only; Arc<[u8]> would force an extra copy"
    )]
    pub bytes: Arc<Vec<u8>>,
    pub content_type: String,
    pub references: u32,
}

#[derive(Debug, Default)]
pub struct RegistryState {
    sessions: HashMap<String, HashMap<String, RegisteredAsset>>,
    total_bytes: usize,
}

/// Process-local delivery registry for live asset sessions.
///
/// Durable bytes live in the attachment store on disk (attachments.rs, keyed
/// by content hash). This registry owns only the bounded runtime delivery
/// cache used by the `WebView` custom protocol.
#[derive(Clone, Debug, Default)]
pub struct AssetProtocolRegistry {
    state: Arc<RwLock<RegistryState>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AssetProtocolError {
    InvalidToken,
    InvalidContentHash,
    UnsupportedContentType,
    AssetTooLarge,
    RegistryBudgetExceeded,
    DuplicateAsset,
    ReferenceOverflow,
    NotFound,
    Internal,
}
impl AssetProtocolRegistry {
    pub fn open_session(&self, session_token: &str) -> Result<(), AssetProtocolError> {
        validate_token(session_token)?;

        let mut state = self
            .state
            .write()
            .map_err(|_| AssetProtocolError::Internal)?;

        if state.sessions.contains_key(session_token) {
            return Err(AssetProtocolError::DuplicateAsset);
        }

        state
            .sessions
            .insert(session_token.to_owned(), HashMap::new());

        Ok(())
    }

    pub fn insert(
        &self,
        session_token: &str,
        asset_token: &str,
        content_hash: &str,
        content_type: &str,
        bytes: Vec<u8>,
    ) -> Result<(), AssetProtocolError> {
        validate_token(session_token)?;
        validate_token(asset_token)?;
        validate_content_hash(content_hash)?;
        validate_content_type(content_type)?;

        /*
         * Runtime asset identity is the canonical lowercase SHA-256 digest.
         * Session tokens remain opaque, but asset tokens are deliberately
         * content-addressed so the same binary has one Native identity.
         */
        if asset_token != content_hash {
            return Err(AssetProtocolError::InvalidContentHash);
        }

        if bytes.len() > MAX_ASSET_BYTES {
            return Err(AssetProtocolError::AssetTooLarge);
        }

        /*
         * 摘要在这里付一次，而且在拿写锁之前付。
         *
         * 这条入口此前只核对了 asset_token 与 content_hash 两个字符串相等，从未对
         * 字节本身做过摘要 —— 身份完全由调用方声明：一个谎报的身份会原样进注册表，
         * 容器索引说这段字节是 A，它其实是 B。
         *
         * AssetSessionSnapshotEntry 的文档说"字段私有是因为这个保证就是这个类型的
         * 全部价值"。那个保证此前在这条路径上并不成立，现在成立。
         */
        if hex::encode(Sha256::digest(bytes.as_slice())) != content_hash {
            return Err(AssetProtocolError::InvalidContentHash);
        }

        let mut state = self
            .state
            .write()
            .map_err(|_| AssetProtocolError::Internal)?;

        /*
         * Read before the session borrow so the whole insert needs one map
         * lookup. Previously the borrow was released to reach total_bytes and
         * the session had to be looked up a second time to store the asset.
         */
        let current_total = state.total_bytes;

        let session = state
            .sessions
            .get_mut(session_token)
            .ok_or(AssetProtocolError::NotFound)?;

        if let Some(existing) = session.get_mut(asset_token) {
            /*
             * 只比 content_type。字节不必再比：两侧的摘要都已经对着各自的字节验过，
             * 相同的 SHA-256 就是相同的字节 —— 这本来就是整套内容寻址的前提。
             *
             * 此前这里在持有写锁的情况下做一次最多 32 MB 的 memcmp，每一次重复插入
             * 都要付，而它试图给出的保证，上面那次摘要已经给了。
             */
            if existing.content_type != content_type {
                return Err(AssetProtocolError::DuplicateAsset);
            }

            existing.references = existing
                .references
                .checked_add(1)
                .ok_or(AssetProtocolError::ReferenceOverflow)?;

            return Ok(());
        }

        let next_total = current_total
            .checked_add(bytes.len())
            .ok_or(AssetProtocolError::RegistryBudgetExceeded)?;

        if next_total > MAX_REGISTRY_BYTES {
            return Err(AssetProtocolError::RegistryBudgetExceeded);
        }

        // Arc::new adopts the Vec the IPC layer already allocated. Arc::from
        // would reallocate and copy the asset in full.
        session.insert(
            asset_token.to_owned(),
            RegisteredAsset {
                bytes: Arc::new(bytes),
                content_type: content_type.to_owned(),
                references: 1,
            },
        );

        state.total_bytes = next_total;

        Ok(())
    }

    pub fn remove(
        &self,
        session_token: &str,
        asset_token: &str,
    ) -> Result<bool, AssetProtocolError> {
        validate_token(session_token)?;
        validate_token(asset_token)?;

        let mut state = self
            .state
            .write()
            .map_err(|_| AssetProtocolError::Internal)?;

        let Some(session) = state.sessions.get_mut(session_token) else {
            return Ok(false);
        };

        let Some(asset) = session.get_mut(asset_token) else {
            return Ok(false);
        };

        if asset.references > 1 {
            asset.references -= 1;
            return Ok(true);
        }

        let removed = session
            .remove(asset_token)
            .ok_or(AssetProtocolError::Internal)?;

        state.total_bytes = state.total_bytes.saturating_sub(removed.bytes.len());

        Ok(true)
    }

    pub fn remove_session(&self, session_token: &str) -> Result<bool, AssetProtocolError> {
        validate_token(session_token)?;

        let mut state = self
            .state
            .write()
            .map_err(|_| AssetProtocolError::Internal)?;

        let Some(assets) = state.sessions.remove(session_token) else {
            return Ok(false);
        };

        let removed_bytes = assets
            .values()
            .map(|asset| asset.bytes.len())
            .sum::<usize>();

        state.total_bytes = state.total_bytes.saturating_sub(removed_bytes);

        Ok(true)
    }

    /// 换掉一条交付会话：撤旧与铺新在同一次写锁里完成。
    ///
    /// 打开一条对话此前是"先拆掉旧会话，末尾再铺新的"，两次写锁之间隔着一次
    /// 库读和一整趟磁盘读，那段时间这条会话在注册表里并不存在 —— 而这条命令
    /// 的重入是常态：Ctrl+R 与第二个窗口都会让它重来一遍。旧页面上还挂着的
    /// <img> 在那一瞬取到的是 404，协议这一侧没有重试，于是它就一直是个破图标。
    ///
    /// 分两步做替换从来不是一个可以靠调用方"小心一点"解决的问题，所以原语
    /// 放在这里：中间态不对读者出现，因为它压根不存在。
    ///
    /// # Errors
    ///
    /// 令牌不合法、单张超限、或换上去之后越过注册表预算时返回错误；失败时
    /// 原来那一份原封不动。
    pub fn replace_session(
        &self,
        session_token: &str,
        assets: Vec<AssetSessionSnapshotEntry>,
    ) -> Result<(), AssetProtocolError> {
        validate_token(session_token)?;

        let (restored_assets, restored_bytes) = materialise(assets)?;

        let mut state = self
            .state
            .write()
            .map_err(|_| AssetProtocolError::Internal)?;

        /* 旧的那一份先从账上减掉再算总量。不减就是把同一条会话的字节反复计入，
        而打开对话这件事一天里会发生很多次 —— 那笔账只会朝一个方向漂。 */
        let released = state.sessions.get(session_token).map_or(0, |assets| {
            assets
                .values()
                .map(|asset| asset.bytes.len())
                .sum::<usize>()
        });

        let next_total = state
            .total_bytes
            .saturating_sub(released)
            .checked_add(restored_bytes)
            .ok_or(AssetProtocolError::RegistryBudgetExceeded)?;

        if next_total > MAX_REGISTRY_BYTES {
            return Err(AssetProtocolError::RegistryBudgetExceeded);
        }

        state
            .sessions
            .insert(session_token.to_owned(), restored_assets);

        state.total_bytes = next_total;

        Ok(())
    }

    /// 注册表此刻替所有会话记着多少字节。
    ///
    /// 只给测试消费（宿主的 HTTP 语义测试也要拿它对账）。预算是这个类型唯一
    /// 一笔跨会话的状态，也是替换写错时唯一会出问题的地方，而它从外面完全
    /// 看不见 —— 看不见的不变量等于没有不变量。
    #[doc(hidden)]
    pub fn total_bytes(&self) -> usize {
        self.state.read().map_or(0, |state| state.total_bytes)
    }

    /// 把一份字节从一条会话过继到另一条，并把它交给调用方读。
    ///
    /// 输入框那条会话（用户挑图的地方）与一条对话的交付会话是两条：前者在
    /// 用户放手的那一刻就存在，后者要等这一句真的发出去。同一份字节因此要
    /// 同时挂在两处 —— 挂的是同一个 Arc，不是第二份内存，注册表按引用计数
    /// 管它，这也正是 RegisteredAsset 一开始就带 references 的理由。
    ///
    /// 内存共用，账不共用：预算按「会话 × 资源」记，过继之后同一份字节在账上
    /// 是两份。那不是漏洞 —— remove 与 remove_session 也各减一份，而这笔账唯
    /// 一的硬性要求就是加减对得上。少记这一份，两条会话关闭时会各减一次，总量
    /// 朝下漂，MAX_REGISTRY_BYTES 就此形同虚设，那是危险的那一侧。
    ///
    /// 代价是这个上限对共用的字节偏保守（最多多算一倍）。要让它变成真正的内存
    /// 计数，得把引用计数从「每条会话一份」提到全局按内容摘要一份 —— 那是另一
    /// 件事，换来的只是一个 256 MB 缓存上限更准一点。
    ///
    /// 交回内容类型与字节本身：调用方（agent_prompt 的 keep_bytes）要拿它们
    /// 落盘、记账，以及编成 ACP 要的那一份 base64。让它另外再查一次表，等于
    /// 让同一把写锁开两趟。
    ///
    /// 源里没有这份东西时返回 Ok(None)：那不是故障，是「这张图已经不在了」，
    /// 该由调用方翻译成一句人话，不是一个内部错误。
    ///
    /// # Errors
    ///
    /// 令牌不合法、目标会话不存在、或过继之后越过注册表预算时返回错误；
    /// 失败时两条会话都原封不动。
    pub fn adopt(
        &self,
        from_session: &str,
        from_token: &str,
        into_session: &str,
    ) -> Result<Option<(String, Arc<Vec<u8>>)>, AssetProtocolError> {
        validate_token(from_session)?;
        validate_token(from_token)?;
        validate_token(into_session)?;

        let mut state = self
            .state
            .write()
            .map_err(|_| AssetProtocolError::Internal)?;

        /* 取的是 RegisteredAsset 的克隆：一个 Arc 加一个 String，与字节数无关。 */
        let Some(found) = state
            .sessions
            .get(from_session)
            .and_then(|assets| assets.get(from_token))
            .cloned()
        else {
            return Ok(None);
        };

        let current_total = state.total_bytes;

        let session = state
            .sessions
            .get_mut(into_session)
            .ok_or(AssetProtocolError::NotFound)?;

        if let Some(existing) = session.get_mut(from_token) {
            if existing.content_type != found.content_type {
                return Err(AssetProtocolError::DuplicateAsset);
            }

            existing.references = existing
                .references
                .checked_add(1)
                .ok_or(AssetProtocolError::ReferenceOverflow)?;

            return Ok(Some((found.content_type, found.bytes)));
        }

        let next_total = current_total
            .checked_add(found.bytes.len())
            .ok_or(AssetProtocolError::RegistryBudgetExceeded)?;

        if next_total > MAX_REGISTRY_BYTES {
            return Err(AssetProtocolError::RegistryBudgetExceeded);
        }

        let content_type = found.content_type.clone();
        let bytes = Arc::clone(&found.bytes);

        session.insert(
            from_token.to_owned(),
            RegisteredAsset {
                bytes: found.bytes,
                content_type: found.content_type,
                references: 1,
            },
        );

        state.total_bytes = next_total;

        Ok(Some((content_type, bytes)))
    }
    /// 按令牌取出这份已验身份的资源，交给宿主的 HTTP 层成形。
    ///
    /// URI 解析与 Range 语义是 HTTP 的事，留在宿主；这里只认令牌与注册表。
    pub fn deliver(
        &self,
        session_token: &str,
        asset_token: &str,
    ) -> Result<DeliveredAsset, AssetProtocolError> {
        validate_token(session_token)?;
        validate_token(asset_token)?;

        let asset = self
            .state
            .read()
            .map_err(|_| AssetProtocolError::Internal)?
            .sessions
            .get(session_token)
            .and_then(|assets| assets.get(asset_token))
            .cloned()
            .ok_or(AssetProtocolError::NotFound)?;

        Ok(DeliveredAsset {
            content_type: asset.content_type,
            bytes: asset.bytes,
        })
    }
}

/// 交付面上调用方拿到的那一份：内容类型与字节（共享 Arc，不是拷贝）。
#[derive(Clone, Debug)]
pub struct DeliveredAsset {
    pub content_type: String,
    pub bytes: Arc<Vec<u8>>,
}

/// 把一批已验身份的资源物化成一条会话的内容，以及它一共占多少字节。
///
/// 单张与整批的上限都在这里算清，而且在任何人拿写锁之前算清 —— 失败因此
/// 不可能留下半条会话，replace_session 的原子性正是在这里实现的。
pub fn materialise(
    assets: Vec<AssetSessionSnapshotEntry>,
) -> Result<(HashMap<String, RegisteredAsset>, usize), AssetProtocolError> {
    let mut restored_assets = HashMap::<String, RegisteredAsset>::new();
    let mut restored_bytes = 0_usize;

    for asset in assets {
        if asset.bytes.len() > MAX_ASSET_BYTES {
            return Err(AssetProtocolError::AssetTooLarge);
        }

        restored_bytes = restored_bytes
            .checked_add(asset.bytes.len())
            .ok_or(AssetProtocolError::RegistryBudgetExceeded)?;

        if restored_bytes > MAX_REGISTRY_BYTES {
            return Err(AssetProtocolError::RegistryBudgetExceeded);
        }

        let AssetSessionSnapshotEntry {
            content_hash,
            content_type,
            bytes,
        } = asset;

        let registered = RegisteredAsset {
            bytes,
            content_type,
            references: 1,
        };

        if restored_assets.insert(content_hash, registered).is_some() {
            return Err(AssetProtocolError::DuplicateAsset);
        }
    }

    Ok((restored_assets, restored_bytes))
}

/// 这条资源在 webview 里的地址。
///
/// 形状随平台变，因为 WebView2 不解析自定义 scheme：Windows 上 Tauri 把注册的
/// 协议挂在 `http://<scheme>.localhost` 上，官方的 convertFileSrc 生成的正是
/// 这一条；macOS 与 Linux 用真正的 scheme。
///
/// `poietica-asset.localhost` 这个 host，tauri.conf.json 的 CSP 也一直放行着
/// 它 —— 而全仓没有一处生成过它。于是 Windows 上每一条附件 URL 都指向一个取
/// 不到东西的地址，重启之后整条对话的图片全是破图标；实时那条路当时看起来
/// 正常，只是因为它当时走的是 data: 内联 —— 那条路已收敛掉：地址如今只有这
/// 一种，由持有字节的原生侧随 agent_prompt 的答复交出。
pub fn asset_protocol_url(
    session_token: &str,
    asset_token: &str,
) -> Result<String, AssetProtocolError> {
    validate_token(session_token)?;
    validate_token(asset_token)?;

    if cfg!(windows) {
        return Ok(format!(
            "http://{ASSET_PROTOCOL_SCHEME}.localhost/{ASSET_PROTOCOL_HOST}/{session_token}/{asset_token}"
        ));
    }

    Ok(format!(
        "{ASSET_PROTOCOL_SCHEME}://{ASSET_PROTOCOL_HOST}/{session_token}/{asset_token}"
    ))
}

pub fn validate_token(value: &str) -> Result<(), AssetProtocolError> {
    if value.is_empty() || value.len() > MAX_TOKEN_BYTES {
        return Err(AssetProtocolError::InvalidToken);
    }

    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(AssetProtocolError::InvalidToken);
    }

    Ok(())
}

/// 这个字符串是不是一个规范的 SHA-256 摘要。
///
/// 磁盘上的目录名就是摘要，一个宽一格的判定在落盘那侧等于一次路径穿越，
/// 所以判定与校验共用这一份。
pub fn validate_content_hash(content_hash: &str) -> Result<(), AssetProtocolError> {
    if crate::formats::is_content_hash(content_hash) {
        return Ok(());
    }

    Err(AssetProtocolError::InvalidContentHash)
}

pub fn validate_content_type(content_type: &str) -> Result<(), AssetProtocolError> {
    /* 名单的正本是 crate::commands::asset 的 DELIVERABLE_CONTENT_TYPES，同一张表
     * 不许抄两份。 */
    if crate::formats::is_deliverable_content_type(content_type) {
        return Ok(());
    }

    Err(AssetProtocolError::UnsupportedContentType)
}
