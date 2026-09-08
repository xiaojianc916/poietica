use thiserror::Error;

pub const MAX_ASSET_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const MAX_REGISTRY_BYTES: usize = 256 * 1024 * 1024;
const MAX_TOKEN_BYTES: usize = 128;

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum AssetProtocolError {
    #[error("invalid asset token")]
    InvalidToken,
    #[error("invalid content identity")]
    InvalidContentHash,
    #[error("unsupported content type")]
    UnsupportedContentType,
    #[error("asset exceeds the size limit")]
    AssetTooLarge,
    #[error("asset registry budget exceeded")]
    RegistryBudgetExceeded,
    #[error("conflicting or duplicate asset")]
    DuplicateAsset,
    #[error("asset reference count overflow")]
    ReferenceOverflow,
    #[error("asset session or resource not found")]
    NotFound,
    #[error("asset registry unavailable")]
    Internal,
}

pub fn validate_token(value: &str) -> Result<(), AssetProtocolError> {
    if value.is_empty()
        || value.len() > MAX_TOKEN_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(AssetProtocolError::InvalidToken);
    }
    Ok(())
}

pub fn validate_content_hash(value: &str) -> Result<(), AssetProtocolError> {
    if crate::formats::is_content_hash(value) {
        Ok(())
    } else {
        Err(AssetProtocolError::InvalidContentHash)
    }
}

pub fn validate_content_type(value: &str) -> Result<(), AssetProtocolError> {
    if crate::formats::is_deliverable_content_type(value) {
        Ok(())
    } else {
        Err(AssetProtocolError::UnsupportedContentType)
    }
}
