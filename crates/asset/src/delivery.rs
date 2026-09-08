use crate::identity::{AssetProtocolError, validate_token};
pub const ASSET_PROTOCOL_SCHEME: &str = "poietica-asset";
pub const ASSET_PROTOCOL_HOST: &str = "asset";
pub fn asset_protocol_url(
    session_token: &str,
    asset_token: &str,
) -> Result<String, AssetProtocolError> {
    validate_token(session_token)?;
    validate_token(asset_token)?;

    if cfg!(windows) {
        return Ok(format!(
            "http://{ASSET_PROTOCOL_SCHEME}.localhost/{ASSET_PROTOCOL_HOST}/{session_token}/{asset_token}"
        ));
    }

    Ok(format!(
        "{ASSET_PROTOCOL_SCHEME}://{ASSET_PROTOCOL_HOST}/{session_token}/{asset_token}"
    ))
}
