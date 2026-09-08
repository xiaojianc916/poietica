#![allow(
    clippy::rc_buffer,
    reason = "Arc<Vec<u8>> shares the ingestion allocation without copying bytes"
)]
use crate::identity::{
    AssetProtocolError, MAX_ASSET_BYTES, validate_content_hash, validate_content_type,
};
use sha2::{Digest, Sha256};
use std::sync::Arc;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetSessionSnapshotEntry {
    content_hash: String,
    content_type: String,
    bytes: Arc<Vec<u8>>,
}

impl AssetSessionSnapshotEntry {
    pub fn from_bytes(bytes: Vec<u8>) -> Result<Self, AssetProtocolError> {
        if bytes.len() > MAX_ASSET_BYTES {
            return Err(AssetProtocolError::AssetTooLarge);
        }
        let content_type =
            crate::formats::sniff(&bytes).ok_or(AssetProtocolError::UnsupportedContentType)?;
        validate_content_type(content_type)?;
        Ok(Self {
            content_hash: hex::encode(Sha256::digest(&bytes)),
            content_type: content_type.to_owned(),
            bytes: Arc::new(bytes),
        })
    }

    pub fn verify(
        content_hash: String,
        content_type: String,
        bytes: Arc<Vec<u8>>,
    ) -> Result<Self, AssetProtocolError> {
        validate_content_hash(&content_hash)?;
        validate_content_type(&content_type)?;
        if bytes.len() > MAX_ASSET_BYTES {
            return Err(AssetProtocolError::AssetTooLarge);
        }
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
    pub fn bytes(&self) -> &Arc<Vec<u8>> {
        &self.bytes
    }
    pub(crate) fn into_parts(self) -> (String, String, Arc<Vec<u8>>) {
        (self.content_hash, self.content_type, self.bytes)
    }
}
