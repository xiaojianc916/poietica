//! 收得下的格式：一张表管文件头判定、Content-Type 与扩展名。

use sha2::{Digest, Sha256};

/// extensions 必须与文件对话框那份名单一致：漏改任一侧都不报错，只会安静地坏。
#[derive(Clone, Copy, Debug)]
pub struct Format {
    pub kind: AssetKind,
    pub content_type: &'static str,
    pub extensions: &'static [&'static str],
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AssetKind {
    Image,
    Text,
}

impl AssetKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Text => "text",
        }
    }
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

/// 每行 content_type 必须落在 DELIVERABLE_CONTENT_TYPES 里（由测试把守）；文本判据是兜底，排最后。
pub const FORMATS: &[Format] = &[
    Format {
        kind: AssetKind::Image,
        content_type: "image/png",
        extensions: &["png"],
        matches: is_png,
    },
    Format {
        kind: AssetKind::Image,
        content_type: "image/jpeg",
        extensions: &["jpg", "jpeg"],
        matches: is_jpeg,
    },
    Format {
        kind: AssetKind::Image,
        content_type: "image/gif",
        extensions: &["gif"],
        matches: is_gif,
    },
    Format {
        kind: AssetKind::Image,
        content_type: "image/bmp",
        extensions: &["bmp"],
        matches: is_bmp,
    },
    Format {
        kind: AssetKind::Image,
        content_type: "image/webp",
        extensions: &["webp"],
        matches: is_webp,
    },
    Format {
        kind: AssetKind::Image,
        content_type: "image/avif",
        extensions: &["avif"],
        matches: is_avif,
    },
    Format {
        kind: AssetKind::Text,
        content_type: "text/plain",
        extensions: &[
            "txt", "md", "markdown", "json", "jsonc", "yaml", "yml", "toml", "ini", "csv", "tsv",
            "ts", "tsx", "js", "jsx", "mjs", "cjs", "css", "scss", "html", "xml", "sql", "rs",
            "go", "py", "rb", "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php",
            "lua", "sh", "bash", "zsh", "ps1", "diff", "patch", "log",
        ],
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

pub fn sniff(bytes: &[u8]) -> Option<&'static str> {
    FORMATS
        .iter()
        .find(|format| (format.matches)(bytes))
        .map(|format| format.content_type)
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
