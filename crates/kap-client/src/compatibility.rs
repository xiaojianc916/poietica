//! 运行时兼容门禁的 REST 半边。
//!
//! 协议版本由 WS 握手判（connection/handshake.rs 的 validate_protocol_version）；
//! 这里判 /meta 自述的能力集必须覆盖 contracts/kap/capabilities.json 钉住的那一组。
//! 缺一个就不连，而不是连上之后在某条路由上静默丢字段。
//! 发送与信封解包仍走 crate 唯一那条 REST 路（session/rest.rs 的 get）。

use serde_json::Value;

use crate::error::{KapError, Result};
use crate::generated::rest::routes;
use crate::session::rest::get;

/// 钉住的能力集矩阵，由 tools/contract/kap-spec-sync.ts 从快照派生。
const PINNED: &str = include_str!("../../../contracts/kap/capabilities.json");

fn pinned_meta_capabilities() -> Result<Vec<String>> {
    let matrix: Value = serde_json::from_str(PINNED).map_err(|error| KapError::Transport {
        message: format!("the pinned capability matrix is unreadable: {error}"),
    })?;

    let declared = matrix
        .get("meta_capabilities")
        .and_then(Value::as_array)
        .ok_or_else(|| KapError::Transport {
            message: "the pinned capability matrix has no meta_capabilities".to_owned(),
        })?;

    Ok(declared
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect())
}

/// GET /meta，并要求它覆盖钉住的能力集；不覆盖即给可行动错误。
pub(crate) async fn require_pinned_capabilities(
    http: &reqwest::Client,
    base_url: &str,
) -> Result<()> {
    let pinned = pinned_meta_capabilities()?;
    let meta = get(http, routes::meta(base_url)).await?;

    let offered = meta
        .get("capabilities")
        .and_then(Value::as_object)
        .ok_or_else(|| KapError::Handshake {
            message: "GET /meta reports no capabilities; compatibility cannot be verified"
                .to_owned(),
        })?;

    let missing: Vec<&str> = pinned
        .iter()
        .map(String::as_str)
        .filter(|name| !offered.contains_key(*name))
        .collect();

    if missing.is_empty() {
        return Ok(());
    }

    Err(KapError::Handshake {
        message: format!(
            "the running kap does not offer the capabilities pinned in contracts/kap: {}",
            missing.join(", ")
        ),
    })
}
