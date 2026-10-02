use crate::identity::{AssetProtocolError, validate_token};
pub const ASSET_PROTOCOL_SCHEME: &str = "poietica-asset";
pub const ASSET_PROTOCOL_HOST: &str = "asset";
/// 三个平台同一条形状：宿主把这条 scheme 注册成特权协议（ADR 0028），
/// WebView2 时代借 localhost 特例绕过的做法随 Tauri 一起作废。
pub fn asset_protocol_url(
    session_token: &str,
    asset_token: &str,
) -> Result<String, AssetProtocolError> {
    validate_token(session_token)?;
    validate_token(asset_token)?;

    Ok(format!(
        "{ASSET_PROTOCOL_SCHEME}://{ASSET_PROTOCOL_HOST}/{session_token}/{asset_token}"
    ))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, reason = "a broken fixture must fail loudly")]

    use super::{ASSET_PROTOCOL_HOST, ASSET_PROTOCOL_SCHEME, asset_protocol_url};

    /// 正本形状只有一条：宿主与渲染层按它取字节，平台差异不存在。
    #[test]
    fn the_url_is_the_custom_scheme_on_every_platform() {
        let hash = "a".repeat(64);
        let url = asset_protocol_url("session", &hash).expect("a well-formed token pair");

        assert_eq!(
            url,
            format!("{ASSET_PROTOCOL_SCHEME}://{ASSET_PROTOCOL_HOST}/session/{hash}")
        );
        assert!(
            !url.contains("localhost"),
            "the host must answer this scheme itself: {url}"
        );
    }

    #[test]
    fn a_token_that_is_not_a_token_never_becomes_a_url() {
        let hash = "a".repeat(64);

        assert!(asset_protocol_url("", &hash).is_err());
        assert!(asset_protocol_url("session", "not/a/token").is_err());
    }
}
