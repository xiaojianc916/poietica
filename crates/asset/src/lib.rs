//! Asset formats, registration and content-addressed bytes.

pub mod blob;
pub mod formats;
pub mod registry;

pub use formats::{
    AssetKind, FORMATS, Format, is_content_hash, is_deliverable_content_type, sniff,
};
pub use registry::{
    ASSET_PROTOCOL_HOST, ASSET_PROTOCOL_SCHEME, AssetProtocolError, AssetProtocolRegistry,
    AssetSessionSnapshotEntry, DeliveredAsset, RegisteredAsset, RegistryState, asset_protocol_url,
    materialise, validate_content_hash, validate_content_type, validate_token,
};
