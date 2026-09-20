//! Range 请求：认出区间、落到资源实际长度上。

use tauri::http::{Request, header::RANGE};

/// 认不出的写法（含多区间）退成 None 即整份交付：RFC 9110 要求忽略读不懂的 range unit。
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

    if start.is_none() && end.is_none() {
        return None;
    }

    /* start > end 的 range-spec 无效（RFC 9110 §14.1.1），退整份交付而非 500。 */
    if let (Some(start), Some(end)) = (start, end)
        && start > end
    {
        return None;
    }

    Some((start, end))
}

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
