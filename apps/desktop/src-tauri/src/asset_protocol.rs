//! 资产协议的 HTTP 面：URI 解析、Range/206 与响应成形。
//!
//! 注册表与身份校验住在 `poietica_asset`（R1 领域）；这里只把一次协议请求
//! 变成一次 HTTP 应答 —— 查注册表、落区间、抄头。
//!
//! 单文件而不拆：响应成形（Range/206）与状态码映射共用同一组常量与同一条
//! 错误语义，拆开要么公开内部类型，要么复制语义 —— 两者都是为拆而拆。

use tauri::http::{
    Request, Response, StatusCode,
    header::{
        ACCEPT_RANGES, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE,
        X_CONTENT_TYPE_OPTIONS,
    },
};

use poietica_asset::ASSET_PROTOCOL_HOST;

/// 领域类型经这里对组合根可见：实现住在 poietica_asset，宿主只是协议面。
pub use poietica_asset::{
    ASSET_PROTOCOL_SCHEME, AssetProtocolError, AssetProtocolRegistry, AssetSessionSnapshotEntry,
    asset_protocol_url,
};

/// 一次协议请求 → 一次 HTTP 应答。宿主接线（bootstrap/app.rs）只调这一个。
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

/// 从请求 URI 里拆出会话与资产两个令牌。
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

/// 请求里那个字节区间，以 `bytes=` 的两个端点原样交回；没提 Range 就是 None。
///
/// 只认单区间。多区间要回 multipart/byteranges，而没有任何浏览器会对
/// <video> 或 <img> 发多区间请求 —— 支持它等于为一条不存在的路径写一个解析器。
/// 认不出的写法退成 None，也就是整份交付：这是 RFC 9110 允许的行为
/// （`An origin server MUST ignore a Range header field that contains a
/// range unit it does not understand`），比回 416 更不容易把一个本来能播的
/// 资源变成播不了。
fn requested_range<B>(request: &Request<B>) -> Option<(Option<u64>, Option<u64>)> {
    let value = request.headers().get(RANGE)?.to_str().ok()?;
    let spec = value.trim().strip_prefix("bytes=")?.trim();

    if spec.contains(',') {
        return None;
    }

    let (first, last) = spec.split_once('-')?;

    let start = match first.trim() {
        "" => None,
        text => Some(text.parse::<u64>().ok()?),
    };

    let end = match last.trim() {
        "" => None,
        text => Some(text.parse::<u64>().ok()?),
    };

    // `bytes=-` 两端都空，不是一个区间。
    if start.is_none() && end.is_none() {
        return None;
    }

    /*
     * last-pos 小于 first-pos 的 range-spec 是无效的（RFC 9110 §14.1.1），按本文件
     * 一贯的做法退成整份交付。此前它会一路走到 asset_response，在那里
     * `bytes.get(5..=2)` 取不到切片，回一个 500 —— 一个畸形的请求头不该被报成
     * 服务端内部错误。
     */
    if let (Some(start), Some(end)) = (start, end)
        && start > end
    {
        return None;
    }

    Some((start, end))
}

/// 把请求的区间落到这份资源的实际长度上，得到一个闭区间 `[start, end]`。
///
/// 三种写法都要认，因为浏览器三种都会发：`bytes=500-999` 取一段、
/// `bytes=500-` 从某处到末尾（seek 之后的续播）、`bytes=-500` 取末尾若干字节
/// （取容器尾部的索引，mp4 的 moov 在尾部时就是这样）。
///
/// 落不到有效区间时返回 None，由调用方回 416 并带上真实长度。
fn resolve_range(requested: (Option<u64>, Option<u64>), length: u64) -> Option<(u64, u64)> {
    if length == 0 {
        return None;
    }

    let last = length - 1;

    match requested {
        (Some(start), Some(end)) if start <= last => Some((start, end.min(last))),
        (Some(start), None) if start <= last => Some((start, last)),
        (None, Some(suffix)) if suffix > 0 => Some((length.saturating_sub(suffix), last)),
        _unsatisfiable => None,
    }
}

/// 交付这份资源，整份或其中一段。
///
/// 无论对方有没有提 Range，都发 Accept-Ranges：那是「可以对我发 Range」这件事
/// 唯一的宣告方式，媒体元素据此决定进度条能不能拖。
fn asset_response(
    asset: &poietica_asset::DeliveredAsset,
    requested: Option<(Option<u64>, Option<u64>)>,
) -> Response<Vec<u8>> {
    let length = asset.bytes.len() as u64;

    let common = Response::builder()
        .header(CONTENT_TYPE, asset.content_type.as_str())
        .header(ACCEPT_RANGES, "bytes")
        .header(X_CONTENT_TYPE_OPTIONS, "nosniff")
        // 身份是内容摘要，所以同一条 URL 的字节永远不会变。
        .header(CACHE_CONTROL, "private, max-age=31536000, immutable");

    let Some(requested) = requested else {
        return common
            .status(StatusCode::OK)
            .header(CONTENT_LENGTH, length.to_string())
            .body(asset.bytes.as_ref().clone())
            .unwrap_or_else(|_| empty_response(StatusCode::INTERNAL_SERVER_ERROR));
    };

    let Some((start, end)) = resolve_range(requested, length) else {
        /*
         * 416 必须带上真实长度，否则对方无从修正自己的请求。RFC 9110 为这个
         * 状态码规定的 Content-Range 形式就是 `bytes * /<length>`。
         */
        return Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(CONTENT_RANGE, format!("bytes */{length}"))
            .header(ACCEPT_RANGES, "bytes")
            .header(CONTENT_LENGTH, "0")
            .header(X_CONTENT_TYPE_OPTIONS, "nosniff")
            .header(CACHE_CONTROL, "no-store")
            .body(Vec::new())
            .unwrap_or_else(|_| empty_response(StatusCode::RANGE_NOT_SATISFIABLE));
    };

    /*
     * 区间请求只拷对方要的那一段。整份交付那一支拷的是全部，而那一次拷贝去不掉：
     * Tauri 用 Into<Cow<'static, [u8]>> 框住响应体，注册表持有的字节不是 'static，
     * 只能以 Cow::Owned 交出去。
     *
     * 能选的只有由谁来付。bootstrap/app.rs 用异步协议把整个处理器搬进
     * spawn_blocking，所以付这笔账的不是画窗口的那条线程。
     */
    let slice = asset
        .bytes
        .get(usize::try_from(start).unwrap_or(usize::MAX)..=usize::try_from(end).unwrap_or(0))
        .map(<[u8]>::to_vec);

    let Some(slice) = slice else {
        return empty_response(StatusCode::INTERNAL_SERVER_ERROR);
    };

    common
        .status(StatusCode::PARTIAL_CONTENT)
        .header(CONTENT_RANGE, format!("bytes {start}-{end}/{length}"))
        .header(CONTENT_LENGTH, slice.len().to_string())
        .body(slice)
        .unwrap_or_else(|_| empty_response(StatusCode::INTERNAL_SERVER_ERROR))
}

fn empty_response(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(CONTENT_LENGTH, "0")
        .header(X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(CACHE_CONTROL, "no-store")
        .body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
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
    use sha2::{Digest, Sha256};
    use std::sync::Arc;

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

        registry
            .insert(
                session,
                &content_hash,
                &content_hash,
                content_type,
                bytes.to_vec(),
            )
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

    /*
     * 允许清单里有 video/mp4 与 application/pdf，而媒体元素靠 206 做 seek。
     * 这几条用例把「可以对我发 Range」从一句注释变成一个会失败的断言。
     */
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
            // 越界的上端点收敛到最后一个字节，不是一个错误。
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

    /*
     * 认不出的 Range 退成整份交付，不是 416：RFC 9110 要求源服务器忽略它读不懂
     * 的 range unit。回 416 会把一个本来能播的资源变成播不了的。
     */
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

    /*
     * 生成器与解析器必须对得上，而且要按平台对。
     *
     * 上面那些用例手拼 URI，所以它们绕过了 asset_protocol_url —— 那道缝正是
     * Windows 上整条对话破图的地方。这一条从生成器出发，走完整条解析路径。
     */
    #[test]
    fn the_url_it_hands_out_resolves_on_this_platform() {
        let registry = AssetProtocolRegistry::default();

        registry
            .open_session("session-1")
            .expect("session should open");

        let asset = insert(&registry, "session-1", "image/png", &[1, 2, 3]);
        let url = asset_protocol_url("session-1", &asset).expect("url should build");

        /* 逐字比，不比前缀：畸形 URL 的前缀断言在非 Windows 宿主上跑不到。 */
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

        /* 同一份字节只记一次账：第二次插入只是把引用加一。 */
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

        let result = registry.insert(
            "session-1",
            "different-token",
            &content_hash,
            "image/png",
            bytes,
        );

        assert_eq!(result, Err(AssetProtocolError::InvalidContentHash),);
    }

    /*
     * 这条路径此前只比对两个字符串，字节从未被摘要过：谎报身份的插入会成功。
     */
    #[test]
    fn rejects_bytes_that_do_not_match_their_declared_identity() {
        let registry = AssetProtocolRegistry::default();

        registry
            .open_session("session-1")
            .expect("session should open");

        let declared = hash(&[1, 2, 3]);

        let result = registry.insert(
            "session-1",
            &declared,
            &declared,
            "image/png",
            vec![9, 9, 9],
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

    /*
     * The digest check did not disappear, it moved to the only place that can
     * establish it once. An entry claiming an identity its bytes do not have
     * can no longer be built, so no session can be published from one.
     */
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

    /*
     * 打开一条对话会反复走到这里：Ctrl+R 一次，开第二个窗口一次。拆和铺
     * 分成两步的那条路上，中间那段空窗就是屏幕上的破图标；这一个不需要拆。
     */
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

        /* 反复铺同一条会话不该把字节重复计入预算。分两步时这笔账由 remove
        那一半负责减，少走一次就永远回不来，而它对外完全不可见。 */
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

    /*
     * 过继是这一刀的地基：输入框那条会话与对话的交付会话共用同一份内存。
     * 共用没做到，就是每发一句话复制一次最多 32 MB；共用做错了（比如把字节
     * 重复计入预算），账只会朝一个方向漂，而它从外面完全看不见。
     */
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

        /* 源与目标都还在交付：两条 URL 都必须解析。 */
        for session in ["composer", "thread-1"] {
            let response = respond(
                &registry,
                &request(&format!("poietica-asset://asset/{session}/{asset}")),
            );

            assert_eq!(response.status(), StatusCode::OK, "{session}");
        }

        /*
         * 「没有复制」就是字面意思：比 Arc 的地址。这是这一刀的全部价值 ——
         * 共用没做到，就是每发一句话把最多 32 MB 复制一遍。把这份字节再过继
         * 一手，两次交出的必须是同一个 Arc。
         */
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

        /* 账按「会话 × 资源」记，三条会话各记一份。 */
        assert_eq!(registry.total_bytes(), once * 3);

        /*
         * 加减对得上，才是这笔账唯一的硬性要求，也是它唯一会出问题的地方。
         * 漏减一次就永远回不来，而 total_bytes 从外面完全看不见 —— 看不见的
         * 不变量等于没有不变量。
         */
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

            let result =
                registry.insert("session", &content_hash, &content_hash, content_type, bytes);

            assert_eq!(result, Err(AssetProtocolError::UnsupportedContentType),);
        }
    }
}
