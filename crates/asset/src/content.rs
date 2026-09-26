#![allow(
    clippy::rc_buffer,
    reason = "Arc<Vec<u8>> shares the ingestion allocation without copying bytes"
)]
use crate::identity::{
    AssetProtocolError, MAX_ASSET_BYTES, validate_content_hash, validate_content_type,
};
use std::sync::Arc;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetSessionSnapshotEntry {
    content_hash: String,
    content_type: String,
    bytes: Arc<Vec<u8>>,
}

/// 尺寸与内容类型两道门，from_bytes 与 verify 共用。
fn admitted(bytes_len: usize, content_type: &str) -> Result<(), AssetProtocolError> {
    if bytes_len > MAX_ASSET_BYTES {
        return Err(AssetProtocolError::AssetTooLarge);
    }
    validate_content_type(content_type)
}

impl AssetSessionSnapshotEntry {
    pub fn from_bytes(bytes: Vec<u8>) -> Result<Self, AssetProtocolError> {
        // 尺寸门先于嗅探（admission_tests 锚定超限报 AssetTooLarge）；嗅探之后与 verify 同过一道 admitted 门。
        if bytes.len() > MAX_ASSET_BYTES {
            return Err(AssetProtocolError::AssetTooLarge);
        }
        let content_type =
            crate::formats::sniff(&bytes).ok_or(AssetProtocolError::UnsupportedContentType)?;
        admitted(bytes.len(), content_type)?;
        Ok(Self {
            content_hash: crate::formats::digest_hex(&bytes),
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
        admitted(bytes.len(), &content_type)?;
        if crate::formats::digest_hex(bytes.as_slice()) != content_hash {
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
