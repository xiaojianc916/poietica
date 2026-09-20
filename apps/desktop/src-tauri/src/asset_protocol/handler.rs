//! 请求的入口：一次协议请求 → 一次 HTTP 应答。

use tauri::http::{Request, Response, StatusCode};

use poietica_asset::ASSET_PROTOCOL_HOST;

use super::range::requested_range;
use super::response::{asset_response, empty_response};
use crate::asset_protocol::{AssetProtocolError, AssetProtocolRegistry};

pub fn respond<B>(registry: &AssetProtocolRegistry, request: &Request<B>) -> Response<Vec<u8>> {
    match resolve_request(registry, request) {
        Ok(asset) => asset_response(&asset, requested_range(request)),
        Err(AssetProtocolError::NotFound) => empty_response(StatusCode::NOT_FOUND),
        Err(
            AssetProtocolError::InvalidToken
            | AssetProtocolError::InvalidContentHash
            | AssetProtocolError::UnsupportedContentType
            | AssetProtocolError::AssetTooLarge
            | AssetProtocolError::RegistryBudgetExceeded
            | AssetProtocolError::DuplicateAsset
            | AssetProtocolError::ReferenceOverflow,
        ) => empty_response(StatusCode::BAD_REQUEST),
        Err(AssetProtocolError::Internal) => empty_response(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

fn resolve_request<B>(
    registry: &AssetProtocolRegistry,
    request: &Request<B>,
) -> Result<poietica_asset::DeliveredAsset, AssetProtocolError> {
    let uri = request.uri();

    if uri.query().is_some() {
        return Err(AssetProtocolError::InvalidToken);
    }

    let host = uri.host().unwrap_or(ASSET_PROTOCOL_HOST);

    let mut components = uri
        .path()
        .split('/')
        .filter(|component| !component.is_empty());

    if host == "poietica-asset.localhost" || host == "localhost" {
        if components.next() != Some(ASSET_PROTOCOL_HOST) {
            return Err(AssetProtocolError::InvalidToken);
        }
    } else if host != ASSET_PROTOCOL_HOST {
        return Err(AssetProtocolError::InvalidToken);
    }

    let session_token = components.next().ok_or(AssetProtocolError::InvalidToken)?;

    let asset_token = components.next().ok_or(AssetProtocolError::InvalidToken)?;

    if components.next().is_some() {
        return Err(AssetProtocolError::InvalidToken);
    }

    registry.deliver(session_token, asset_token)
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        clippy::unwrap_used,
        clippy::panic,
        clippy::indexing_slicing,
        clippy::shadow_unrelated,
        reason = "tests operate on known-good fixtures; a broken assumption must fail the test loudly"
    )]

    use super::*;
    use crate::asset_protocol::{AssetSessionSnapshotEntry, asset_protocol_url};
    use sha2::{Digest, Sha256};
    use std::sync::Arc;
    use tauri::http::header::{ACCEPT_RANGES, CONTENT_RANGE, CONTENT_TYPE, RANGE};

    fn request(uri: &str) -> Request<()> {
        Request::builder()
            .uri(uri)
            .body(())
            .expect("request should be valid")
    }

    fn hash(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }

    fn insert(
        registry: &AssetProtocolRegistry,
        session: &str,
        content_type: &str,
        bytes: &[u8],
    ) -> String {
        let content_hash = hash(bytes);

        let entry = AssetSessionSnapshotEntry::verify(
            content_hash.clone(),
            content_type.to_owned(),
            Arc::new(bytes.to_vec()),
        )
        .expect("fixture identity");
        registry
            .register(session, vec![entry])
            .expect("asset should register");

        content_hash
    }

    #[test]
    fn serves_content_addressed_asset_without_exposing_a_path() {
        let registry = AssetProtocolRegistry::default();

        registry
            .open_session("session-1")
            .expect("session should open");

        let asset = insert(&registry, "session-1", "image/png", &[1, 2, 3, 4]);

        let response = respond(
            &registry,
            &request(&format!("poietica-asset://asset/session-1/{asset}")),
        );

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(CONTENT_TYPE),
            Some(&"image/png".parse().expect("header value")),
        );
        assert_eq!(response.body(), &vec![1, 2, 3, 4]);
    }

    fn range_request(uri: &str, range: &str) -> Request<()> {
        Request::builder()
            .uri(uri)
            .header(RANGE, range)
            .body(())
            .expect("request should be valid")
    }

    #[test]
    fn serves_the_three_range_forms_browsers_actually_send() {
        let registry = AssetProtocolRegistry::default();

        registry
            .open_session("session-1")
            .expect("session should open");

        let bytes: Vec<u8> = (0..10_u8).collect();
        let asset = insert(&registry, "session-1", "video/mp4", &bytes);
        let uri = format!("poietica-asset://asset/session-1/{asset}");

        for (spec, expected_body, expected_content_range) in [
            ("bytes=2-4", vec![2, 3, 4], "bytes 2-4/10"),
            ("bytes=7-", vec![7, 8, 9], "bytes 7-9/10"),
            ("bytes=-3", vec![7, 8, 9], "bytes 7-9/10"),
            ("bytes=8-100", vec![8, 9], "bytes 8-9/10"),
        ] {
            let response = respond(&registry, &range_request(&uri, spec));

            assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT, "{spec}");
            assert_eq!(response.body(), &expected_body, "{spec}");
            assert_eq!(
                response.headers().get(CONTENT_RANGE),
                Some(&expected_content_range.parse().expect("header value")),
                "{spec}",
            );
        }
    }

    #[test]
    fn announces_range_support_even_without_a_range_header() {
        let registry = AssetProtocolRegistry::default();

        registry
            .open_session("session-1")
            .expect("session should open");

        let asset = insert(&registry, "session-1", "video/mp4", &[1, 2, 3]);

        let response = respond(
            &registry,
            &request(&format!("poietica-asset://asset/session-1/{asset}")),
        );

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(ACCEPT_RANGES),
            Some(&"bytes".parse().expect("header value")),
        );
    }

    #[test]
    fn an_unsatisfiable_range_reports_the_real_length() {
        let registry = AssetProtocolRegistry::default();

        registry
            .open_session("session-1")
            .expect("session should open");

        let asset = insert(&registry, "session-1", "video/mp4", &[1, 2, 3]);

        let response = respond(
            &registry,
            &range_request(
                &format!("poietica-asset://asset/session-1/{asset}"),
                "bytes=99-",
            ),
        );

        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(
            response.headers().get(CONTENT_RANGE),
            Some(&"bytes */3".parse().expect("header value")),
        );
    }

    /* RFC 9110 要求忽略读不懂的 range unit：退整份交付而非 416。 */
    #[test]
    fn an_unreadable_range_falls_back_to_the_whole_asset() {
        let registry = AssetProtocolRegistry::default();

        registry
            .open_session("session-1")
            .expect("session should open");

        let asset = insert(&registry, "session-1", "video/mp4", &[1, 2, 3]);
        let uri = format!("poietica-asset://asset/session-1/{asset}");

        for spec in [
            "items=0-1",
            "bytes=0-1,5-6",
            "bytes=-",
            "bytes=abc-",
            "bytes=5-2",
        ] {
            let response = respond(&registry, &range_request(&uri, spec));

            assert_eq!(response.status(), StatusCode::OK, "{spec}");
            assert_eq!(response.body(), &vec![1, 2, 3], "{spec}");
        }
    }

    #[test]
    fn the_url_it_hands_out_resolves_on_this_platform() {
        let registry = AssetProtocolRegistry::default();

        registry
            .open_session("session-1")
            .expect("session should open");

        let asset = insert(&registry, "session-1", "image/png", &[1, 2, 3]);
        let url = asset_protocol_url("session-1", &asset).expect("url should build");

        let expected = if cfg!(windows) {
            format!("http://poietica-asset.localhost/asset/session-1/{asset}")
        } else {
            format!("poietica-asset://asset/session-1/{asset}")
        };

        assert_eq!(url, expected, "生成器与解析器必须逐字对得上");

        let response = respond(&registry, &request(&url));

        assert_eq!(response.status(), StatusCode::OK, "{url}");
        assert_eq!(response.body(), &vec![1, 2, 3]);
    }

    #[test]
    fn rejects_path_traversal_and_extra_components() {
        let registry = AssetProtocolRegistry::default();

        for uri in [
            "poietica-asset://asset/../asset",
            "poietica-asset://asset/session/asset/extra",
            "poietica-asset://asset/session\\escape/asset",
            "poietica-asset://asset/session/asset?path=secret",
        ] {
            let response = respond(&registry, &request(uri));

            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
    }

    #[test]
    fn removing_session_invalidates_all_urls() {
        let registry = AssetProtocolRegistry::default();

        registry
            .open_session("session-1")
            .expect("session should open");

        let asset = insert(&registry, "session-1", "image/png", &[1, 2, 3]);

        assert!(
            registry
                .remove_session("session-1")
                .expect("session should close")
        );

        let response = respond(
            &registry,
            &request(&format!("poietica-asset://asset/session-1/{asset}")),
        );

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn deduplicates_equal_content_and_tracks_references() {
        let registry = AssetProtocolRegistry::default();

        registry
            .open_session("session-1")
            .expect("session should open");

        let asset = insert(&registry, "session-1", "image/png", &[1, 2, 3]);

        let duplicate = insert(&registry, "session-1", "image/png", &[1, 2, 3]);

        assert_eq!(asset, duplicate);

        assert_eq!(registry.total_bytes(), 3);

        assert!(
            registry
                .remove("session-1", &asset)
                .expect("first reference should be removed")
        );

        let response = respond(
            &registry,
            &request(&format!("poietica-asset://asset/session-1/{asset}")),
        );

        assert_eq!(response.status(), StatusCode::OK);

        assert!(
            registry
                .remove("session-1", &asset)
                .expect("final reference should be removed")
        );

        let response = respond(
            &registry,
            &request(&format!("poietica-asset://asset/session-1/{asset}")),
        );

        assert_eq!(response.status(), StatusCode::NOT_FOUND);

        assert_eq!(registry.total_bytes(), 0);
    }

    #[test]
    fn rejects_non_canonical_content_identity() {
        let registry = AssetProtocolRegistry::default();

        registry
            .open_session("session-1")
            .expect("session should open");

        let bytes = vec![1, 2, 3];
        let content_hash = hash(&bytes);

        let result = AssetSessionSnapshotEntry::verify(
            content_hash.to_uppercase(),
            "image/png".to_owned(),
            Arc::new(bytes),
        );

        assert_eq!(result, Err(AssetProtocolError::InvalidContentHash),);
    }

    #[test]
    fn rejects_bytes_that_do_not_match_their_declared_identity() {
        let registry = AssetProtocolRegistry::default();

        registry
            .open_session("session-1")
            .expect("session should open");

        let declared = hash(&[1, 2, 3]);

        let result = AssetSessionSnapshotEntry::verify(
            declared,
            "image/png".to_owned(),
            Arc::new(vec![9, 9, 9]),
        );

        assert_eq!(result, Err(AssetProtocolError::InvalidContentHash));
    }

    #[allow(
        clippy::rc_buffer,
        reason = "the payload is produced as a Vec and shared read-only; Arc<[u8]> would force an extra copy"
    )]
    fn entry(bytes: &Arc<Vec<u8>>) -> AssetSessionSnapshotEntry {
        AssetSessionSnapshotEntry::verify(
            hash(bytes.as_slice()),
            "image/png".to_owned(),
            Arc::clone(bytes),
        )
        .expect("fixture entry should verify")
    }

    #[test]
    fn an_entry_cannot_claim_an_identity_its_bytes_do_not_have() {
        let result = AssetSessionSnapshotEntry::verify(
            "0".repeat(64),
            "image/png".to_owned(),
            Arc::new(vec![9, 9, 9]),
        );

        assert_eq!(result, Err(AssetProtocolError::InvalidContentHash));
    }

    #[test]
    fn an_entry_cannot_carry_an_active_content_type() {
        let bytes = Arc::new(vec![1, 2, 3]);

        let result = AssetSessionSnapshotEntry::verify(
            hash(bytes.as_slice()),
            "image/svg+xml".to_owned(),
            bytes,
        );

        assert_eq!(result, Err(AssetProtocolError::UnsupportedContentType));
    }

    #[test]
    fn replacing_a_live_session_swaps_its_contents_in_one_step() {
        let registry = AssetProtocolRegistry::default();

        let before = Arc::new(vec![1, 2, 3]);
        let after = Arc::new(vec![4, 5, 6]);

        registry
            .replace_session("thread-1", vec![entry(&before)])
            .expect("first delivery should publish");

        registry
            .replace_session("thread-1", vec![entry(&after)])
            .expect("second delivery should replace, not refuse");

        let stale = respond(
            &registry,
            &request(&format!(
                "poietica-asset://asset/thread-1/{}",
                hash(before.as_slice())
            )),
        );

        assert_eq!(
            stale.status(),
            StatusCode::NOT_FOUND,
            "the old asset should be gone"
        );

        let steady = registry.total_bytes();

        for _repeat in 0..8 {
            registry
                .replace_session("thread-1", vec![entry(&after)])
                .expect("delivery should stay idempotent");
        }

        assert_eq!(
            registry.total_bytes(),
            steady,
            "反复交付同一条会话不该把字节重复计入预算"
        );

        let response = respond(
            &registry,
            &request(&format!(
                "poietica-asset://asset/thread-1/{}",
                hash(after.as_slice())
            )),
        );

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body(), after.as_ref());
    }

    #[test]
    fn adopting_shares_the_bytes_instead_of_copying_them() {
        let registry = AssetProtocolRegistry::default();

        registry
            .open_session("composer")
            .expect("session should open");
        registry
            .open_session("thread-1")
            .expect("session should open");

        let asset = insert(&registry, "composer", "image/png", &[1, 2, 3]);
        let once = registry.total_bytes();

        let (mime, bytes) = registry
            .adopt("composer", &asset, "thread-1")
            .expect("adopting should succeed")
            .expect("the asset is there");

        assert_eq!(mime, "image/png");
        assert_eq!(bytes.as_ref(), &vec![1, 2, 3]);

        for session in ["composer", "thread-1"] {
            let response = respond(
                &registry,
                &request(&format!("poietica-asset://asset/{session}/{asset}")),
            );

            assert_eq!(response.status(), StatusCode::OK, "{session}");
        }

        registry
            .open_session("thread-2")
            .expect("session should open");

        let (_mime, chained) = registry
            .adopt("thread-1", &asset, "thread-2")
            .expect("re-adopting should succeed")
            .expect("the asset is there");

        assert!(
            Arc::ptr_eq(&bytes, &chained),
            "过继必须交出同一份内存，而不是它的副本"
        );

        assert_eq!(registry.total_bytes(), once * 3);

        registry
            .remove_session("composer")
            .expect("the source session should close");
        registry
            .remove_session("thread-1")
            .expect("the target session should close");
        registry
            .remove_session("thread-2")
            .expect("the last session should close");

        assert_eq!(
            registry.total_bytes(),
            0,
            "三条会话都关掉之后账必须归零，否则它只会朝一个方向漂"
        );
    }

    #[test]
    fn adopting_something_that_is_gone_is_not_an_error() {
        let registry = AssetProtocolRegistry::default();

        registry
            .open_session("thread-1")
            .expect("session should open");

        let absent = "0".repeat(64);

        assert_eq!(
            registry.adopt("composer", &absent, "thread-1"),
            Ok(None),
            "源会话不存在就是「这张图已经不在了」，不是内部错误"
        );
    }

    #[test]
    fn rejects_active_or_unknown_content_types() {
        let registry = AssetProtocolRegistry::default();

        registry
            .open_session("session")
            .expect("session should open");

        for content_type in [
            "image/svg+xml",
            "text/html",
            "application/javascript",
            "application/octet-stream",
        ] {
            let bytes = vec![1];
            let content_hash = hash(&bytes);

            let result = AssetSessionSnapshotEntry::verify(
                content_hash,
                content_type.to_owned(),
                Arc::new(bytes),
            );

            assert_eq!(result, Err(AssetProtocolError::UnsupportedContentType),);
        }
    }
}
