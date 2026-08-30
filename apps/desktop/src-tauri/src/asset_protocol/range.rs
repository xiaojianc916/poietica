//! Range 请求：认出区间、落到资源实际长度上。

use tauri::http::{Request, header::RANGE};

/// 请求里那个字节区间，以 `bytes=` 的两个端点原样交回；没提 Range 就是 None。
///
/// 只认单区间。多区间要回 multipart/byteranges，而没有任何浏览器会对
/// <video> 或 <img> 发多区间请求 —— 支持它等于为一条不存在的路径写一个解析器。
/// 认不出的写法退成 None，也就是整份交付：这是 RFC 9110 允许的行为
/// （`An origin server MUST ignore a Range header field that contains a
/// range unit it does not understand`），比回 416 更不容易把一个本来能播的
/// 资源变成播不了。
pub(super) fn requested_range<B>(request: &Request<B>) -> Option<(Option<u64>, Option<u64>)> {
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
     * last-pos 小于 first-pos 的 range-spec 是无效的（RFC 9110 §14.1.1），按本模块
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
pub(super) fn resolve_range(
    requested: (Option<u64>, Option<u64>),
    length: u64,
) -> Option<(u64, u64)> {
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
