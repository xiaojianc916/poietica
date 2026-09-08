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

    pub fn total_bytes(&self) -> usize {
        self.state.read().map_or(0, |state| state.total_bytes)
    }

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

fn materialise(
    assets: Vec<AssetSessionSnapshotEntry>,
) -> Result<(HashMap<String, RegisteredAsset>, usize), AssetProtocolError> {
    let mut restored = HashMap::new();
    let mut bytes_total = 0_usize;
    for asset in assets {
        let (hash, content_type, bytes) = asset.into_parts();
        bytes_total = bytes_total
            .checked_add(bytes.len())
            .ok_or(AssetProtocolError::RegistryBudgetExceeded)?;
        if bytes_total > MAX_REGISTRY_BYTES {
            return Err(AssetProtocolError::RegistryBudgetExceeded);
        }
        if restored
            .insert(
                hash,
                RegisteredAsset {
                    bytes,
                    content_type,
                    references: 1,
                },
            )
            .is_some()
        {
            return Err(AssetProtocolError::DuplicateAsset);
        }
    }
    Ok((restored, bytes_total))
}

#[cfg(test)]
mod admission_tests;
