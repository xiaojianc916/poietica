//! 资产协议的 HTTP 面：URI 解析（handler）、Range/206（range）、响应成形
//! （response）。
//!
//! 注册表与身份校验住在 `poietica_asset`（R1 领域）；这里只把一次协议请求
//! 变成一次 HTTP 应答 —— 查注册表、落区间、抄头。

mod handler;
mod range;
mod response;

pub use handler::respond;

/// 领域类型经这里对组合根可见：实现住在 poietica_asset，宿主只是协议面。
pub use poietica_asset::{
    ASSET_PROTOCOL_SCHEME, AssetProtocolError, AssetProtocolRegistry, AssetSessionSnapshotEntry,
    asset_protocol_url,
};
