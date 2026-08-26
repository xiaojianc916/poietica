//! Native delivery boundary for conversation-attachment binary assets.
//!
//! Two kinds of sessions hold bytes here: the composer's asset session
//! (filled by commands/asset.rs) and one delivery session per conversation
//! (refilled by commands/agent/attachment.rs). Asset bytes are addressed only
//! by opaque session and asset tokens. The protocol never accepts filesystem
//! paths or renderer supplied MIME response headers.
//!
//! 单文件而不拆：注册表状态机、HTTP 语义（Range/206）与校验共用私有类型
//! `RegisteredAsset`，全部服务同一个交付出口（response）。拆开要么公开内部
//! 类型，要么复制校验 —— 两者都是为拆而拆。

use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use tauri::http::{
    Request, Response, StatusCode,
    header::{
        ACCEPT_RANGES, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE,
        X_CONTENT_TYPE_OPTIONS,
    },
};

pub const ASSET_PROTOCOL_SCHEME: &str = "poietica-asset";

const ASSET_PROTOCOL_HOST: &str = "asset";
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
/// the cheap subslicing that would justify a `bytes::Bytes` dependency.
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

    pub fn content_hash(&self) -> &str {
        &self.content_hash
    }

    pub fn content_type(&self) -> &str {
        &self.content_type
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
struct RegisteredAsset {
    #[allow(
        clippy::rc_buffer,
        reason = "the payload is produced as a Vec and shared read-only; Arc<[u8]> would force an extra copy"
    )]
    bytes: Arc<Vec<u8>>,
    content_type: String,
    references: u32,
}

#[derive(Debug, Default)]
struct RegistryState {
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

    /// Restores one complete asset session atomically.
    ///
    /// Every asset is materialized in private temporary state before the
    /// registry write lock is acquired. The session becomes visible only after
    /// the complete resource set and global byte budget have been accepted.
    ///
    /// Failure never publishes an empty or partially restored session.
    ///
    /// Content identity, content type and digest are guaranteed by the entry
    /// type and are deliberately not rechecked. Re-hashing here would charge
    /// every restored asset a second digest that the entry's construction
    /// site already paid or named. Only the registry's own budgets, which the
    /// entry knows nothing about, are enforced below.
    pub fn restore_session(
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

        if state.sessions.contains_key(session_token) {
            return Err(AssetProtocolError::DuplicateAsset);
        }

        let next_total = state
            .total_bytes
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

    /// 换掉一条交付会话：撤旧与铺新在同一次写锁里完成。
    ///
    /// 打开一条对话此前是"先 remove_session，末尾再 restore_session"（见
    /// commands/agent/attachment.rs 的 deliver_attachments）。两次写锁之间隔着一次库读和
    /// 一整趟磁盘读，那段时间这条会话在注册表里并不存在 —— 而这条命令的重入
    /// 是常态：Ctrl+R 与第二个窗口都会让它重来一遍。旧页面上还挂着的 <img>
    /// 在那一瞬取到的是 404，协议这一侧没有重试，于是它就一直是个破图标。
    ///
    /// 分两步做替换从来不是一个可以靠调用方"小心一点"解决的问题，所以原语
    /// 放在这里：中间态不对读者出现，因为它压根不存在。
    ///
    /// 与 restore_session 的差别只有一条：那一个坚持这条会话还不存在（文档
    /// 打开那条路确实以此为前提），这一个不在乎。
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
    /// 只给测试。预算是这个类型唯一一笔跨会话的状态，也是替换写错时唯一会
    /// 出问题的地方，而它从外面完全看不见 —— 看不见的不变量等于没有不变量。
    #[cfg(test)]
    fn total_bytes(&self) -> usize {
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

    pub fn response<B>(&self, request: &Request<B>) -> Response<Vec<u8>> {
        match self.resolve_request(request) {
            Ok(asset) => asset_response(&asset, requested_range(request)),
            Err(AssetProtocolError::NotFound) => empty_response(StatusCode::NOT_FOUND),
            Err(
                AssetProtocolError::InvalidToken
                | AssetProtocolError::InvalidContentHash
                | AssetProtocolError::UnsupportedContentType
                | AssetProtocolError::AssetTooLarge
                | AssetProtocolError::RegistryBudgetExceeded
                | AssetProtocolError::DuplicateAsset
                | AssetProtocolError::ReferenceOverflow,
            ) => empty_response(StatusCode::BAD_REQUEST),
            Err(AssetProtocolError::Internal) => empty_response(StatusCode::INTERNAL_SERVER_ERROR),
        }
    }

    fn resolve_request<B>(
        &self,
        request: &Request<B>,
    ) -> Result<RegisteredAsset, AssetProtocolError> {
        let uri = request.uri();

        if uri.query().is_some() {
            return Err(AssetProtocolError::InvalidToken);
        }

        let host = uri.host().unwrap_or(ASSET_PROTOCOL_HOST);

        let mut components = uri
            .path()
            .split('/')
            .filter(|component| !component.is_empty());

        if host == "poietica-asset.localhost" || host == "localhost" {
            if components.next() != Some(ASSET_PROTOCOL_HOST) {
                return Err(AssetProtocolError::InvalidToken);
            }
        } else if host != ASSET_PROTOCOL_HOST {
            return Err(AssetProtocolError::InvalidToken);
        }

        let session_token = components.next().ok_or(AssetProtocolError::InvalidToken)?;

        let asset_token = components.next().ok_or(AssetProtocolError::InvalidToken)?;

        if components.next().is_some() {
            return Err(AssetProtocolError::InvalidToken);
        }

        validate_token(session_token)?;
        validate_token(asset_token)?;

        let state = self
            .state
            .read()
            .map_err(|_| AssetProtocolError::Internal)?;

        state
            .sessions
            .get(session_token)
            .and_then(|assets| assets.get(asset_token))
            .cloned()
            .ok_or(AssetProtocolError::NotFound)
    }
}

/// 把一批已验身份的资源物化成一条会话的内容，以及它一共占多少字节。
///
/// 单张与整批的上限都在这里算清，而且在任何人拿写锁之前算清 —— 失败因此
/// 不可能留下半条会话，这正是 restore_session 文档里那句「Failure never
/// publishes an empty or partially restored session」的实现处。
///
/// 铺一条新的（restore_session）与换掉一条旧的（replace_session）走的是同一段，
/// 两者的区别只剩下"这条会话已经在了算不算错"这一个判断。
fn materialise(
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

fn validate_token(value: &str) -> Result<(), AssetProtocolError> {
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
/// 判定本身在 attachments.rs：那里是字节落盘的地方，而磁盘上的目录名就是摘要，
/// 一个宽一格的判定在那边等于一次路径穿越。两处各写一份，迟早只有一处会被改。
fn validate_content_hash(content_hash: &str) -> Result<(), AssetProtocolError> {
    if crate::attachments::is_content_hash(content_hash) {
        return Ok(());
    }

    Err(AssetProtocolError::InvalidContentHash)
}

fn validate_content_type(content_type: &str) -> Result<(), AssetProtocolError> {
    const ALLOWED: &[&str] = &[
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/avif",
        "image/bmp",
        "text/plain",
        "video/mp4",
        "video/webm",
        "audio/mpeg",
        "audio/wav",
        "audio/ogg",
        "audio/webm",
        "application/pdf",
    ];

    if ALLOWED.contains(&content_type) {
        return Ok(());
    }

    Err(AssetProtocolError::UnsupportedContentType)
}

/// 请求里那个字节区间，以 `bytes=` 的两个端点原样交回；没提 Range 就是 None。
///
/// 只认单区间。多区间要回 multipart/byteranges，而没有任何浏览器会对
/// <video> 或 <img> 发多区间请求 —— 支持它等于为一条不存在的路径写一个解析器。
/// 认不出的写法退成 None，也就是整份交付：这是 RFC 9110 允许的行为
/// （`An origin server MUST ignore a Range header field that contains a
/// range unit it does not understand`），比回 416 更不容易把一个本来能播的
/// 资源变成播不了。
fn requested_range<B>(request: &Request<B>) -> Option<(Option<u64>, Option<u64>)> {
    let value = request.headers().get(RANGE)?.to_str().ok()?;
    let spec = value.trim().strip_prefix("bytes=")?.trim();

    if spec.contains(',') {
        return None;
    }

    let (first, last) = spec.split_once('-')?;

    let start = match first.trim() {
        "" => None,
        text => Some(text.parse::<u64>().ok()?),
    };

    let end = match last.trim() {
        "" => None,
        text => Some(text.parse::<u64>().ok()?),
    };

    // `bytes=-` 两端都空，不是一个区间。
    if start.is_none() && end.is_none() {
        return None;
    }

    /*
     * last-pos 小于 first-pos 的 range-spec 是无效的（RFC 9110 §14.1.1），按本文件
     * 一贯的做法退成整份交付。此前它会一路走到 asset_response，在那里
     * `bytes.get(5..=2)` 取不到切片，回一个 500 —— 一个畸形的请求头不该被报成
     * 服务端内部错误。
     */
    if let (Some(start), Some(end)) = (start, end)
        && start > end
    {
        return None;
    }

    Some((start, end))
}

/// 把请求的区间落到这份资源的实际长度上，得到一个闭区间 `[start, end]`。
///
/// 三种写法都要认，因为浏览器三种都会发：`bytes=500-999` 取一段、
/// `bytes=500-` 从某处到末尾（seek 之后的续播）、`bytes=-500` 取末尾若干字节
/// （取容器尾部的索引，mp4 的 moov 在尾部时就是这样）。
///
/// 落不到有效区间时返回 None，由调用方回 416 并带上真实长度。
fn resolve_range(requested: (Option<u64>, Option<u64>), length: u64) -> Option<(u64, u64)> {
    if length == 0 {
        return None;
    }

    let last = length - 1;

    match requested {
        (Some(start), Some(end)) if start <= last => Some((start, end.min(last))),
        (Some(start), None) if start <= last => Some((start, last)),
        (None, Some(suffix)) if suffix > 0 => Some((length.saturating_sub(suffix), last)),
        _unsatisfiable => None,
    }
}

/// 交付这份资源，整份或其中一段。
///
/// 无论对方有没有提 Range，都发 Accept-Ranges：那是「可以对我发 Range」这件事
/// 唯一的宣告方式，媒体元素据此决定进度条能不能拖。
fn asset_response(
    asset: &RegisteredAsset,
    requested: Option<(Option<u64>, Option<u64>)>,
) -> Response<Vec<u8>> {
    let length = asset.bytes.len() as u64;

    let common = Response::builder()
        .header(CONTENT_TYPE, asset.content_type.as_str())
        .header(ACCEPT_RANGES, "bytes")
        .header(X_CONTENT_TYPE_OPTIONS, "nosniff")
        // 身份是内容摘要，所以同一条 URL 的字节永远不会变。
        .header(CACHE_CONTROL, "private, max-age=31536000, immutable");

    let Some(requested) = requested else {
        return common
            .status(StatusCode::OK)
            .header(CONTENT_LENGTH, length.to_string())
            .body(asset.bytes.as_ref().clone())
            .unwrap_or_else(|_| empty_response(StatusCode::INTERNAL_SERVER_ERROR));
    };

    let Some((start, end)) = resolve_range(requested, length) else {
        /*
         * 416 必须带上真实长度，否则对方无从修正自己的请求。RFC 9110 为这个
         * 状态码规定的 Content-Range 形式就是 `bytes * /<length>`。
         */
        return Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(CONTENT_RANGE, format!("bytes */{length}"))
            .header(ACCEPT_RANGES, "bytes")
            .header(CONTENT_LENGTH, "0")
            .header(X_CONTENT_TYPE_OPTIONS, "nosniff")
            .header(CACHE_CONTROL, "no-store")
            .body(Vec::new())
            .unwrap_or_else(|_| empty_response(StatusCode::RANGE_NOT_SATISFIABLE));
    };

    /*
     * 区间请求只拷对方要的那一段。整份交付那一支拷的是全部，而那一次拷贝去不掉：
     * Tauri 用 Into<Cow<'static, [u8]>> 框住响应体，注册表持有的字节不是 'static，
     * 只能以 Cow::Owned 交出去。
     *
     * 能选的只有由谁来付。bootstrap/app.rs 用异步协议把整个处理器搬进
     * spawn_blocking，所以付这笔账的不是画窗口的那条线程。
     */
    let slice = asset
        .bytes
        .get(usize::try_from(start).unwrap_or(usize::MAX)..=usize::try_from(end).unwrap_or(0))
        .map(<[u8]>::to_vec);

    let Some(slice) = slice else {
        return empty_response(StatusCode::INTERNAL_SERVER_ERROR);
    };

    common
        .status(StatusCode::PARTIAL_CONTENT)
        .header(CONTENT_RANGE, format!("bytes {start}-{end}/{length}"))
        .header(CONTENT_LENGTH, slice.len().to_string())
        .body(slice)
        .unwrap_or_else(|_| empty_response(StatusCode::INTERNAL_SERVER_ERROR))
}

fn empty_response(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(CONTENT_LENGTH, "0")
        .header(X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(CACHE_CONTROL, "no-store")
        .body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
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

    use super::*;
    use sha2::{Digest, Sha256};

    fn request(uri: &str) -> Request<()> {
        Request::builder()
            .uri(uri)
            .body(())
            .expect("request should be valid")
    }

    fn hash(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }

    fn insert(
        registry: &AssetProtocolRegistry,
        session: &str,
        content_type: &str,
        bytes: &[u8],
    ) -> String {
        let content_hash = hash(bytes);

        registry
            .insert(
                session,
                &content_hash,
                &content_hash,
                content_type,
                bytes.to_vec(),
            )
            .expect("asset should register");

        content_hash
    }

    #[test]
    fn serves_content_addressed_asset_without_exposing_a_path() {
        let registry = AssetProtocolRegistry::default();

        registry
            .open_session("session-1")
            .expect("session should open");

        let asset = insert(&registry, "session-1", "image/png", &[1, 2, 3, 4]);

        let response = registry.response(&request(&format!(
            "poietica-asset://asset/session-1/{asset}"
        )));

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(CONTENT_TYPE),
            Some(&"image/png".parse().expect("header value")),
        );
        assert_eq!(response.body(), &vec![1, 2, 3, 4]);
    }

    fn range_request(uri: &str, range: &str) -> Request<()> {
        Request::builder()
            .uri(uri)
            .header(RANGE, range)
            .body(())
            .expect("request should be valid")
    }

    /*
     * 允许清单里有 video/mp4 与 application/pdf，而媒体元素靠 206 做 seek。
     * 这几条用例把「可以对我发 Range」从一句注释变成一个会失败的断言。
     */
    #[test]
    fn serves_the_three_range_forms_browsers_actually_send() {
        let registry = AssetProtocolRegistry::default();

        registry
            .open_session("session-1")
            .expect("session should open");

        let bytes: Vec<u8> = (0..10_u8).collect();
        let asset = insert(&registry, "session-1", "video/mp4", &bytes);
        let uri = format!("poietica-asset://asset/session-1/{asset}");

        for (spec, expected_body, expected_content_range) in [
            ("bytes=2-4", vec![2, 3, 4], "bytes 2-4/10"),
            ("bytes=7-", vec![7, 8, 9], "bytes 7-9/10"),
            ("bytes=-3", vec![7, 8, 9], "bytes 7-9/10"),
            // 越界的上端点收敛到最后一个字节，不是一个错误。
            ("bytes=8-100", vec![8, 9], "bytes 8-9/10"),
        ] {
            let response = registry.response(&range_request(&uri, spec));

            assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT, "{spec}");
            assert_eq!(response.body(), &expected_body, "{spec}");
            assert_eq!(
                response.headers().get(CONTENT_RANGE),
                Some(&expected_content_range.parse().expect("header value")),
                "{spec}",
            );
        }
    }

    #[test]
    fn announces_range_support_even_without_a_range_header() {
        let registry = AssetProtocolRegistry::default();

        registry
            .open_session("session-1")
            .expect("session should open");

        let asset = insert(&registry, "session-1", "video/mp4", &[1, 2, 3]);

        let response = registry.response(&request(&format!(
            "poietica-asset://asset/session-1/{asset}"
        )));

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(ACCEPT_RANGES),
            Some(&"bytes".parse().expect("header value")),
        );
    }

    #[test]
    fn an_unsatisfiable_range_reports_the_real_length() {
        let registry = AssetProtocolRegistry::default();

        registry
            .open_session("session-1")
            .expect("session should open");

        let asset = insert(&registry, "session-1", "video/mp4", &[1, 2, 3]);

        let response = registry.response(&range_request(
            &format!("poietica-asset://asset/session-1/{asset}"),
            "bytes=99-",
        ));

        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(
            response.headers().get(CONTENT_RANGE),
            Some(&"bytes */3".parse().expect("header value")),
        );
    }

    /*
     * 认不出的 Range 退成整份交付，不是 416：RFC 9110 要求源服务器忽略它读不懂
     * 的 range unit。回 416 会把一个本来能播的资源变成播不了的。
     */
    #[test]
    fn an_unreadable_range_falls_back_to_the_whole_asset() {
        let registry = AssetProtocolRegistry::default();

        registry
            .open_session("session-1")
            .expect("session should open");

        let asset = insert(&registry, "session-1", "video/mp4", &[1, 2, 3]);
        let uri = format!("poietica-asset://asset/session-1/{asset}");

        for spec in [
            "items=0-1",
            "bytes=0-1,5-6",
            "bytes=-",
            "bytes=abc-",
            "bytes=5-2",
        ] {
            let response = registry.response(&range_request(&uri, spec));

            assert_eq!(response.status(), StatusCode::OK, "{spec}");
            assert_eq!(response.body(), &vec![1, 2, 3], "{spec}");
        }
    }

    /*
     * 生成器与解析器必须对得上，而且要按平台对。
     *
     * 上面那些用例手拼 URI，所以它们绕过了 asset_protocol_url —— 那道缝正是
     * Windows 上整条对话破图的地方。这一条从生成器出发，走完整条解析路径。
     */
    #[test]
    fn the_url_it_hands_out_resolves_on_this_platform() {
        let registry = AssetProtocolRegistry::default();

        registry
            .open_session("session-1")
            .expect("session should open");

        let asset = insert(&registry, "session-1", "image/png", &[1, 2, 3]);
        let url = asset_protocol_url("session-1", &asset).expect("url should build");

        /* 逐字比，不比前缀：畸形 URL 的前缀断言在非 Windows 宿主上跑不到。 */
        let expected = if cfg!(windows) {
            format!("http://poietica-asset.localhost/asset/session-1/{asset}")
        } else {
            format!("poietica-asset://asset/session-1/{asset}")
        };

        assert_eq!(url, expected, "生成器与解析器必须逐字对得上");

        let response = registry.response(&request(&url));

        assert_eq!(response.status(), StatusCode::OK, "{url}");
        assert_eq!(response.body(), &vec![1, 2, 3]);
    }

    #[test]
    fn rejects_path_traversal_and_extra_components() {
        let registry = AssetProtocolRegistry::default();

        for uri in [
            "poietica-asset://asset/../asset",
            "poietica-asset://asset/session/asset/extra",
            "poietica-asset://asset/session\\escape/asset",
            "poietica-asset://asset/session/asset?path=secret",
        ] {
            let response = registry.response(&request(uri));

            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
    }

    #[test]
    fn removing_session_invalidates_all_urls() {
        let registry = AssetProtocolRegistry::default();

        registry
            .open_session("session-1")
            .expect("session should open");

        let asset = insert(&registry, "session-1", "image/png", &[1, 2, 3]);

        assert!(
            registry
                .remove_session("session-1")
                .expect("session should close")
        );

        let response = registry.response(&request(&format!(
            "poietica-asset://asset/session-1/{asset}"
        )));

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn deduplicates_equal_content_and_tracks_references() {
        let registry = AssetProtocolRegistry::default();

        registry
            .open_session("session-1")
            .expect("session should open");

        let asset = insert(&registry, "session-1", "image/png", &[1, 2, 3]);

        let duplicate = insert(&registry, "session-1", "image/png", &[1, 2, 3]);

        assert_eq!(asset, duplicate);

        /* 同一份字节只记一次账：第二次插入只是把引用加一。 */
        assert_eq!(registry.total_bytes(), 3);

        assert!(
            registry
                .remove("session-1", &asset)
                .expect("first reference should be removed")
        );

        let response = registry.response(&request(&format!(
            "poietica-asset://asset/session-1/{asset}"
        )));

        assert_eq!(response.status(), StatusCode::OK);

        assert!(
            registry
                .remove("session-1", &asset)
                .expect("final reference should be removed")
        );

        let response = registry.response(&request(&format!(
            "poietica-asset://asset/session-1/{asset}"
        )));

        assert_eq!(response.status(), StatusCode::NOT_FOUND);

        assert_eq!(registry.total_bytes(), 0);
    }

    #[test]
    fn rejects_non_canonical_content_identity() {
        let registry = AssetProtocolRegistry::default();

        registry
            .open_session("session-1")
            .expect("session should open");

        let bytes = vec![1, 2, 3];
        let content_hash = hash(&bytes);

        let result = registry.insert(
            "session-1",
            "different-token",
            &content_hash,
            "image/png",
            bytes,
        );

        assert_eq!(result, Err(AssetProtocolError::InvalidContentHash),);
    }

    /*
     * 这条路径此前只比对两个字符串，字节从未被摘要过：谎报身份的插入会成功。
     */
    #[test]
    fn rejects_bytes_that_do_not_match_their_declared_identity() {
        let registry = AssetProtocolRegistry::default();

        registry
            .open_session("session-1")
            .expect("session should open");

        let declared = hash(&[1, 2, 3]);

        let result = registry.insert(
            "session-1",
            &declared,
            &declared,
            "image/png",
            vec![9, 9, 9],
        );

        assert_eq!(result, Err(AssetProtocolError::InvalidContentHash));
    }

    #[allow(
        clippy::rc_buffer,
        reason = "the payload is produced as a Vec and shared read-only; Arc<[u8]> would force an extra copy"
    )]
    fn entry(bytes: &Arc<Vec<u8>>) -> AssetSessionSnapshotEntry {
        AssetSessionSnapshotEntry::verify(
            hash(bytes.as_slice()),
            "image/png".to_owned(),
            Arc::clone(bytes),
        )
        .expect("fixture entry should verify")
    }

    #[test]
    fn restores_complete_content_addressed_session() {
        let registry = AssetProtocolRegistry::default();

        let first_bytes = Arc::new(vec![1, 2, 3]);
        let second_bytes = Arc::new(vec![4, 5, 6]);

        let first_hash = hash(first_bytes.as_slice());
        let second_hash = hash(second_bytes.as_slice());

        registry
            .restore_session(
                "restored-session",
                vec![entry(&second_bytes), entry(&first_bytes)],
            )
            .expect("session should restore");

        let first_response = registry.response(&request(&format!(
            "poietica-asset://asset/restored-session/{first_hash}"
        )));

        assert_eq!(first_response.status(), StatusCode::OK,);

        assert_eq!(first_response.body(), first_bytes.as_ref(),);

        let second_response = registry.response(&request(&format!(
            "poietica-asset://asset/restored-session/{second_hash}"
        )));

        assert_eq!(second_response.status(), StatusCode::OK,);

        assert_eq!(second_response.body(), second_bytes.as_ref(),);
    }

    /*
     * The digest check did not disappear, it moved to the only place that can
     * establish it once. An entry claiming an identity its bytes do not have
     * can no longer be built, so no session can be restored from one.
     */
    #[test]
    fn an_entry_cannot_claim_an_identity_its_bytes_do_not_have() {
        let result = AssetSessionSnapshotEntry::verify(
            "0".repeat(64),
            "image/png".to_owned(),
            Arc::new(vec![9, 9, 9]),
        );

        assert_eq!(result, Err(AssetProtocolError::InvalidContentHash));
    }

    #[test]
    fn an_entry_cannot_carry_an_active_content_type() {
        let bytes = Arc::new(vec![1, 2, 3]);

        let result = AssetSessionSnapshotEntry::verify(
            hash(bytes.as_slice()),
            "image/svg+xml".to_owned(),
            bytes,
        );

        assert_eq!(result, Err(AssetProtocolError::UnsupportedContentType));
    }

    /*
     * Atomicity is a property of restore_session itself, so it is now exercised
     * through a rejection restore_session still owns: its own byte budget.
     */
    #[test]
    fn rejected_restore_does_not_publish_partial_session() {
        let registry = AssetProtocolRegistry::default();

        let small = Arc::new(vec![1, 2, 3]);
        let oversized = Arc::new(vec![0_u8; MAX_ASSET_BYTES + 1]);

        let result =
            registry.restore_session("failed-session", vec![entry(&small), entry(&oversized)]);

        assert_eq!(result, Err(AssetProtocolError::AssetTooLarge));

        let response = registry.response(&request(&format!(
            "poietica-asset://asset/failed-session/{}",
            hash(small.as_slice())
        )));

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn duplicate_restore_hash_does_not_publish_session() {
        let registry = AssetProtocolRegistry::default();

        let bytes = Arc::new(vec![1, 2, 3]);

        let result =
            registry.restore_session("duplicate-session", vec![entry(&bytes), entry(&bytes)]);

        assert_eq!(result, Err(AssetProtocolError::DuplicateAsset),);

        let response = registry.response(&request(&format!(
            "poietica-asset://asset/duplicate-session/{}",
            hash(bytes.as_slice())
        )));

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    /*
     * 打开一条对话会反复走到这里：Ctrl+R 一次，开第二个窗口一次。
     * restore_session 会拒绝第二次 —— 那正是调用方此前不得不先把它拆掉的原因，
     * 而拆和铺之间那段空窗就是屏幕上的破图标。这一个不需要拆。
     */
    #[test]
    fn replacing_a_live_session_swaps_its_contents_in_one_step() {
        let registry = AssetProtocolRegistry::default();

        let before = Arc::new(vec![1, 2, 3]);
        let after = Arc::new(vec![4, 5, 6]);

        registry
            .replace_session("thread-1", vec![entry(&before)])
            .expect("first delivery should publish");

        registry
            .replace_session("thread-1", vec![entry(&after)])
            .expect("second delivery should replace, not refuse");

        assert!(
            !registry
                .contains("thread-1", &hash(before.as_slice()))
                .expect("the old asset should be gone")
        );

        assert!(
            registry
                .contains("thread-1", &hash(after.as_slice()))
                .expect("the new asset should resolve")
        );

        /* 反复铺同一条会话不该把字节重复计入预算。分两步时这笔账由 remove
        那一半负责减，少走一次就永远回不来，而它对外完全不可见。 */
        let steady = registry.total_bytes();

        for _repeat in 0..8 {
            registry
                .replace_session("thread-1", vec![entry(&after)])
                .expect("delivery should stay idempotent");
        }

        assert_eq!(
            registry.total_bytes(),
            steady,
            "反复交付同一条会话不该把字节重复计入预算"
        );

        let response = registry.response(&request(&format!(
            "poietica-asset://asset/thread-1/{}",
            hash(after.as_slice())
        )));

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body(), after.as_ref());
    }

    /*
     * 过继是这一刀的地基：输入框那条会话与对话的交付会话共用同一份内存。
     * 共用没做到，就是每发一句话复制一次最多 32 MB；共用做错了（比如把字节
     * 重复计入预算），账只会朝一个方向漂，而它从外面完全看不见。
     */
    #[test]
    fn adopting_shares_the_bytes_instead_of_copying_them() {
        let registry = AssetProtocolRegistry::default();

        registry
            .open_session("composer")
            .expect("session should open");
        registry
            .open_session("thread-1")
            .expect("session should open");

        let asset = insert(&registry, "composer", "image/png", &[1, 2, 3]);
        let once = registry.total_bytes();

        let (mime, bytes) = registry
            .adopt("composer", &asset, "thread-1")
            .expect("adopting should succeed")
            .expect("the asset is there");

        assert_eq!(mime, "image/png");
        assert_eq!(bytes.as_ref(), &vec![1, 2, 3]);

        assert!(
            registry
                .contains("composer", &asset)
                .expect("source keeps it")
        );
        assert!(
            registry
                .contains("thread-1", &asset)
                .expect("target has it")
        );

        /*
         * 「没有复制」就是字面意思：比 Arc 的地址。
         *
         * 这是这一刀的全部价值 —— 共用没做到，就是每发一句话把最多 32 MB 复制
         * 一遍。此前这里断言的是 total_bytes()，那测的是记账，不是内存，而且
         * 期望写错了：它按「预算只涨一份」写，见 adopt 的文档。
         */
        let held = registry
            .snapshot_session("composer")
            .expect("the source session should snapshot");

        assert_eq!(held.len(), 1);
        assert!(
            Arc::ptr_eq(held[0].bytes(), &bytes),
            "过继必须交出同一份内存，而不是它的副本"
        );

        /* 账按「会话 × 资源」记，两条会话各记一份。 */
        assert_eq!(registry.total_bytes(), once * 2);

        let response = registry.response(&request(&format!(
            "poietica-asset://asset/thread-1/{asset}"
        )));

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body(), &vec![1, 2, 3]);

        /*
         * 加减对得上，才是这笔账唯一的硬性要求，也是它唯一会出问题的地方。
         * 漏减一次就永远回不来，而 total_bytes 从外面完全看不见 —— 看不见的
         * 不变量等于没有不变量。
         */
        registry
            .remove_session("composer")
            .expect("the source session should close");
        registry
            .remove_session("thread-1")
            .expect("the target session should close");

        assert_eq!(
            registry.total_bytes(),
            0,
            "两条会话都关掉之后账必须归零，否则它只会朝一个方向漂"
        );
    }

    #[test]
    fn adopting_something_that_is_gone_is_not_an_error() {
        let registry = AssetProtocolRegistry::default();

        registry
            .open_session("thread-1")
            .expect("session should open");

        let absent = "0".repeat(64);

        assert_eq!(
            registry.adopt("composer", &absent, "thread-1"),
            Ok(None),
            "源会话不存在就是「这张图已经不在了」，不是内部错误"
        );
    }

    #[test]
    fn rejects_active_or_unknown_content_types() {
        let registry = AssetProtocolRegistry::default();

        registry
            .open_session("session")
            .expect("session should open");

        for content_type in [
            "image/svg+xml",
            "text/html",
            "application/javascript",
            "application/octet-stream",
        ] {
            let bytes = vec![1];
            let content_hash = hash(&bytes);

            let result =
                registry.insert("session", &content_hash, &content_hash, content_type, bytes);

            assert_eq!(result, Err(AssetProtocolError::UnsupportedContentType),);
        }
    }
}
