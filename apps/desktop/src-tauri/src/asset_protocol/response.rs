//! HTTP 应答的成形：状态码、Content-Range 与缓存头。

use tauri::http::{
    Response, StatusCode,
    header::{
        ACCEPT_RANGES, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE,
        X_CONTENT_TYPE_OPTIONS,
    },
};

use super::range::resolve_range;

/// 交付这份资源，整份或其中一段。
///
/// 无论对方有没有提 Range，都发 Accept-Ranges：那是「可以对我发 Range」这件事
/// 唯一的宣告方式，媒体元素据此决定进度条能不能拖。
pub(super) fn asset_response(
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

pub(super) fn empty_response(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(CONTENT_LENGTH, "0")
        .header(X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(CACHE_CONTROL, "no-store")
        .body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}
