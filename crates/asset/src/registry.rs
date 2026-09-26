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
