//! 收得下的格式：一张表管文件头判定与 Content-Type。

use sha2::{Digest, Sha256};

/// 一种按文件头认得出来的内容。
#[derive(Clone, Copy, Debug)]
pub struct Format {
    pub content_type: &'static str,
    pub matches: fn(&[u8]) -> bool,
}

fn is_png(bytes: &[u8]) -> bool {
    bytes.starts_with(b"\x89PNG\r\n\x1a\n")
}

fn is_jpeg(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xFF, 0xD8, 0xFF])
}

fn is_gif(bytes: &[u8]) -> bool {
    bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")
}

fn is_bmp(bytes: &[u8]) -> bool {
    bytes.starts_with(b"BM")
}

fn is_webp(bytes: &[u8]) -> bool {
    bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP".as_slice())
}

fn is_avif(bytes: &[u8]) -> bool {
    bytes.get(4..12) == Some(b"ftypavif".as_slice())
}

/// 判定文本只看这么多字节。与 Kimi 的 FS_BINARY_SAMPLE_BYTES 同一个数。
const TEXT_SAMPLE_BYTES: usize = 4 * 1024;

/// 样本边界可能切断多字节字符：Utf8Error::error_len() 为 None 是「还没读完」而非「不是文本」。
fn is_text(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return false;
    }

    let sample = bytes.get(..TEXT_SAMPLE_BYTES).unwrap_or(bytes);

    if sample.contains(&0) {
        return false;
    }

    match std::str::from_utf8(sample) {
        Ok(_text) => true,
        Err(error) => error.error_len().is_none() && error.valid_up_to() > 0,
    }
}

/// 文件选择框收所有文件（见对话框里的「所有文件」过滤器），这张表只负责把认得
/// 文件头的字节叫出名字：图片进内存注册表走预览，文本与其它文件一律按通用文件
/// 落盘、原样投递。文本判据是兜底，排最后。
pub const FORMATS: &[Format] = &[
    Format {
        content_type: "image/png",
        matches: is_png,
    },
    Format {
        content_type: "image/jpeg",
        matches: is_jpeg,
    },
    Format {
        content_type: "image/gif",
        matches: is_gif,
    },
    Format {
        content_type: "image/bmp",
        matches: is_bmp,
    },
    Format {
        content_type: "image/webp",
        matches: is_webp,
    },
    Format {
        content_type: "image/avif",
        matches: is_avif,
    },
    Format {
        content_type: "text/plain",
        matches: is_text,
    },
];

/// 投递侧收得下的全部内容类型（正本）：媒体与 PDF 只从 agent 产物与恢复路径进来，没有文件头可嗅探。
const DELIVERABLE_CONTENT_TYPES: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/bmp",
    "text/plain",
    "video/mp4",
    "video/webm",
    "audio/mpeg",
    "audio/wav",
    "audio/ogg",
    "audio/webm",
    "application/pdf",
];

pub fn is_deliverable_content_type(content_type: &str) -> bool {
    DELIVERABLE_CONTENT_TYPES.contains(&content_type)
}

/// 不进展示协议、只按文件原样投递的那一类：嗅不出来的字节统一归它。
pub const GENERIC_FILE_CONTENT_TYPE: &str = "application/octet-stream";

/// 图片与「其它文件」的分界：只有图片进内存注册表走预览，其余一律落盘当文件。
#[must_use]
pub fn is_image_content_type(content_type: &str) -> bool {
    content_type.starts_with("image/")
}

pub fn sniff(bytes: &[u8]) -> Option<&'static str> {
    FORMATS
        .iter()
        .find(|format| (format.matches)(bytes))
        .map(|format| format.content_type)
}

/// 进门文件的内容类型：认得的按文件头，认不得的按通用文件收下（选择框不再二选一）。
#[must_use]
pub fn classify(bytes: &[u8]) -> &'static str {
    sniff(bytes).unwrap_or(GENERIC_FILE_CONTENT_TYPE)
}

/// 磁盘目录名就是摘要：判定放宽一格等于落盘侧的路径穿越，故从严。
#[must_use]
pub fn is_content_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

pub(crate) fn digest_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
