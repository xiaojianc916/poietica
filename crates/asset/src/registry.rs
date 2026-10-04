#![allow(
    clippy::rc_buffer,
    reason = "registered payloads share their existing ingestion allocation"
)]
use crate::content::AssetSessionSnapshotEntry;
use crate::identity::{AssetProtocolError, MAX_REGISTRY_BYTES, validate_token};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

#[derive(Clone, Debug)]
struct RegisteredAsset {
    bytes: Arc<Vec<u8>>,
    content_type: String,
    references: u32,
}

#[derive(Debug, Default)]
struct RegistryState {
    sessions: HashMap<String, HashMap<String, RegisteredAsset>>,
    total_bytes: usize,
}

#[derive(Clone, Debug, Default)]
pub struct AssetProtocolRegistry {
    state: Arc<RwLock<RegistryState>>,
}

#[derive(Clone, Debug)]
pub struct DeliveredAsset {
    pub content_type: String,
    pub bytes: Arc<Vec<u8>>,
}

/// 一次移除的结果。
///
/// 两档分开的理由见 `remove`：会话不在册是错误（`NotFound`），而资产不在册是正常的一档
/// —— 通用文件本就不进内存注册表。合成一个 bool 会让前者静默成功。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Removal {
    /// 真的放掉了（含引用数减一）。
    Released,
    /// 会话在册，但这份资产不在册里 —— 通用文件走的就是这一档。
    NotRegistered,
}

/// 一次读要交出哪一段字节。
///
/// 单独一条函数是因为它是纯算术、有边界情况（越界、饱和、空段），而它的调用方
/// （apps/desktop/native/src/asset.rs）够不到宿主端口就能写出来的东西本该住在这里，
/// 也就该在这里被单测钉住（AGENTS.md §3 的「薄」判据）。
///
/// 越界的 offset 收敛成空段而不是报错：Range 头是渲染层给的，浏览器按它自己算的长度
/// 发；交回 0 字节比让整张图 500 更接近正确行为。
pub fn read_span(total: usize, offset: Option<u64>, length: Option<u64>) -> std::ops::Range<usize> {
    let start = usize::try_from(offset.unwrap_or(0))
        .unwrap_or(usize::MAX)
        .min(total);
    let end = match length {
        Some(length) => start.saturating_add(usize::try_from(length).unwrap_or(usize::MAX)),
        None => total,
    }
    .min(total);

    start..end
}

impl AssetProtocolRegistry {
    /// Validation is complete before any live session is changed.
    pub fn register(
        &self,
        session_token: &str,
        assets: Vec<AssetSessionSnapshotEntry>,
    ) -> Result<(), AssetProtocolError> {
        validate_token(session_token)?;
        let mut additions = HashMap::<String, RegisteredAsset>::new();
        for asset in assets {
            let (hash, content_type, bytes) = asset.into_parts();
            if let Some(existing) = additions.get_mut(&hash) {
                if existing.content_type != content_type {
                    return Err(AssetProtocolError::DuplicateAsset);
                }
                existing.references = existing
                    .references
                    .checked_add(1)
                    .ok_or(AssetProtocolError::ReferenceOverflow)?;
            } else {
                additions.insert(
                    hash,
                    RegisteredAsset {
                        bytes,
                        content_type,
                        references: 1,
                    },
                );
            }
        }
        let mut state = self
            .state
            .write()
            .map_err(|_| AssetProtocolError::Internal)?;
        let session = state
            .sessions
            .get(session_token)
            .ok_or(AssetProtocolError::NotFound)?;
        let mut next_total = state.total_bytes;
        for (hash, incoming) in &mut additions {
            if let Some(existing) = session.get(hash) {
                if existing.content_type != incoming.content_type {
                    return Err(AssetProtocolError::DuplicateAsset);
                }
                incoming.references = existing
                    .references
                    .checked_add(incoming.references)
                    .ok_or(AssetProtocolError::ReferenceOverflow)?;
                incoming.bytes = Arc::clone(&existing.bytes);
            } else {
                next_total = next_total
                    .checked_add(incoming.bytes.len())
                    .ok_or(AssetProtocolError::RegistryBudgetExceeded)?;
                if next_total > MAX_REGISTRY_BYTES {
                    return Err(AssetProtocolError::RegistryBudgetExceeded);
                }
            }
        }
        state
            .sessions
            .get_mut(session_token)
            .ok_or(AssetProtocolError::Internal)?
            .extend(additions);
        state.total_bytes = next_total;
        Ok(())
    }
    /// 问一句「这个会话成立吗」：形状合法**且**真的开过。
    ///
    /// 与 `open_session` 分开：那个是**开**一个新会话（已存在就报重复），
    /// 这个是**认**一个已经开过的会话。导入那条路要的是后者 —— 它不该顺手开会话，
    /// 也不该只验形状就放行。
    pub fn open_existing(&self, session_token: &str) -> Result<(), AssetProtocolError> {
        validate_token(session_token)?;

        let state = self
            .state
            .read()
            .map_err(|_| AssetProtocolError::Internal)?;

        if state.sessions.contains_key(session_token) {
            return Ok(());
        }

        Err(AssetProtocolError::NotFound)
    }

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

    /// 放掉一份附件。
    ///
    /// 两种「没删到」必须分开：**会话不在册**说明这次调用走错了会话（拿 A 的令牌去 B
    /// 里删），那是调用方的缺陷；**会话在册但资产不在**是正常的 —— 通用文件不进内存
    /// 注册表（在 tmp 暂存，启动对账清），它本来就没有可放的东西。
    /// 两者从前共用同一个 false，于是跨会话的删除静默成功，界面以为已释放、预算还占着。
    pub fn remove(
        &self,
        session_token: &str,
        asset_token: &str,
    ) -> Result<Removal, AssetProtocolError> {
        validate_token(session_token)?;
        validate_token(asset_token)?;

        let mut state = self
            .state
            .write()
            .map_err(|_| AssetProtocolError::Internal)?;

        let Some(session) = state.sessions.get_mut(session_token) else {
            return Err(AssetProtocolError::NotFound);
        };

        let Some(asset) = session.get_mut(asset_token) else {
            /*
             * 这个会话不在册，但**别的会话**拿着它：调用方用错了会话令牌。
             *
             * 只按「本会话没有」判会漏掉真正要防的那一件 —— 拿 A 的令牌去 B 里删时，
             * B 本身是存在的，于是「查无此项」看起来和通用文件那一档一模一样，
             * 界面据此认为已释放、A 那边其实还占着（实测过的那条缺陷）。
             * 而通用文件从不进任何会话，所以「谁都没有」才是那一档的判据。
             */
            let elsewhere = state
                .sessions
                .iter()
                .any(|(token, assets)| token != session_token && assets.contains_key(asset_token));

            return if elsewhere {
                Err(AssetProtocolError::NotFound)
            } else {
                Ok(Removal::NotRegistered)
            };
        };

        if asset.references > 1 {
            asset.references -= 1;
            return Ok(Removal::Released);
        }

        let removed = session
            .remove(asset_token)
            .ok_or(AssetProtocolError::Internal)?;

        state.total_bytes = state.total_bytes.saturating_sub(removed.bytes.len());

        Ok(Removal::Released)
    }

    pub fn total_bytes(&self) -> usize {
        self.state.read().map_or(0, |state| state.total_bytes)
    }

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

#[cfg(test)]
mod admission_tests;
