//! HTTP 应答的成形：状态码、Content-Range 与缓存头。

use tauri::http::{
    Response, StatusCode,
    header::{
        ACCEPT_RANGES, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE,
        X_CONTENT_TYPE_OPTIONS,
    },
};

use super::range::resolve_range;

/// 始终发 Accept-Ranges：媒体元素据此判断能否对这份资源拖进度条。
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
        // RFC 9110：416 必须带真实长度，Content-Range 形式就是 `bytes * /<length>`。
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

    // 整份交付那次拷贝去不掉：Tauri 的响应体要求 Into<Cow<'static, [u8]>>，而注册表持有的字节不是 'static；处理器已在 spawn_blocking，拷贝不占画窗线程。
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
