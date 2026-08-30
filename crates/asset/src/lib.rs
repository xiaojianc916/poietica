//! 附件与内容寻址资产：身份、格式判定与交付注册表。
//!
//! 字节的身份是 SHA-256 摘要；令牌是唯一入口，这里不认文件系统路径。
//! HTTP 语义（Range/206 与状态码映射）归宿主的协议处理器。

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
