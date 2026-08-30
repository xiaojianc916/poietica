//! 收得下的格式：一张表管文件头判定、Content-Type 与扩展名。
//!
//! 魔数、内容类型、扩展名长在一起，因为它们是同一条策略的三个面：拿什么判、
//! 投递时写在 Content-Type 上的那个字符串、系统对话框里能被选中的名字。
//! 加一种格式就是这里加一行，没有第二处要跟着改。

/// 一种收得下的格式。
///
/// 文件头、内容类型、扩展名长在一起，因为它们是同一条策略的三个面：拿什么判、
/// 投递时写在 Content-Type 上的那个字符串、系统对话框里能被选中的名字。
///
/// 最后一样此前住在 TypeScript 里（曾为 desktop-adapters 的 IMAGE_EXTENSIONS，随包合并退役），靠
/// 一句注释和这里保持一致。漏改哪一侧都不会报错，只会安静地坏：多在对话框那
/// 侧，用户选得中却什么也不发生；多在这一侧，新格式等于没加。
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

/// 一种可附件的东西：缩略图那一类，还是纯色磁贴那一类。
///
/// 渲染层据此选画法，系统对话框据此分组。这是这张表唯一的分类维度。
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

/// 这段字节是文本吗：首 4 KiB 是合法 UTF-8 且不含 NUL。
///
/// UTF-8 合法性交给 std::str::from_utf8，不自己数字节。样本边界会把一个多字节
/// 字符切断，那不是「不是文本」—— Utf8Error::error_len() 为 None 正是「还没读完」，
/// 所以退到 valid_up_to() 再判一次。NUL 是二进制最稳的标志，Kimi 的
/// classifyTextSample 也以它作硬判据。
fn is_text(bytes: &[u8]) -> bool {
    /* 空文件什么都不是：没有内容就没有种类，与「认不出来就是不投递」同一条。 */
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

/// 这个应用收得下的全部格式，按判定顺序排。魔数、内容类型、扩展名、种类只在
/// 这里出现一次；文本排在最后 —— 它的判据是「不像任何一种图」的兜底，而图的
/// 魔数各自唯一。加一种格式就是这里加一行，没有第二处要跟着改。每一行的内容
/// 类型必须落在下面的 DELIVERABLE_CONTENT_TYPES 里，否则注册表的 insert 会拒，
/// 而那时错误说的就不是真正的原因了 —— 这条由测试把着，不靠约定。
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

/// 资产协议投递侧收得下的全部内容类型 —— 正本，全仓唯一一份。
///
/// 用户导得进的那几种在上面 FORMATS 里，各有文件头判据；媒体与 PDF 只从 agent
/// 产物与会话恢复路径进入注册表，没有文件头可嗅探，因此在这里只有类型没有行。
/// 导入先经 FORMATS 嗅探、再过这张表（asset_protocol 的 validate_content_type
/// 引用的就是它），两道门用的是同一份名单，不会一个放行一个拦下。
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

/// 这类内容投递得出去吗。
pub fn is_deliverable_content_type(content_type: &str) -> bool {
    DELIVERABLE_CONTENT_TYPES.contains(&content_type)
}

/// 认文件头，不认扩展名。认不出来就是不投递。
///
/// 只在 FORMATS 里查，所以它不可能交回一种没有登记过的类型 —— 这不靠约定，
/// 靠的是没有别的地方可返回。
pub fn sniff(bytes: &[u8]) -> Option<&'static str> {
    FORMATS
        .iter()
        .find(|format| (format.matches)(bytes))
        .map(|format| format.content_type)
}

/// 这个字符串是不是一个规范的 SHA-256 摘要（64 个小写十六进制字符）。
///
/// 磁盘上的目录名就是摘要，一个宽一格的判定在落盘那侧等于一次路径穿越，
/// 所以判定与校验共用这一份。
#[must_use]
pub fn is_content_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}
