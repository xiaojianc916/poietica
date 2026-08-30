use thiserror::Error;

/// 插件字节从来源搬到磁盘上，这一路可能出的事。
///
/// 宿主层会把它们统统折成 Error::Plugin，用户看到的是一句固定文案 —— 但日志里要
/// 分得清是归档坏了、路径想越界，还是这份来源里根本没有清单。
#[derive(Debug, Error)]
pub enum ExtensionError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("archive error: {0}")]
    Archive(#[from] zip::result::ZipError),

    #[error("walk error: {0}")]
    Walk(#[from] walkdir::Error),

    #[error("path prefix error: {0}")]
    Prefix(#[from] std::path::StripPrefixError),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("invalid plugin ledger: {0}")]
    InvalidInventory(&'static str),

    #[error("plugin is absent from installed.json: {0}")]
    MissingPlugin(String),

    /// 归档里有一条会写到目标目录之外的路径。
    #[error("archive entry escapes the destination")]
    UnsafeEntry,

    /// 顶层与唯一子目录里都没有插件清单。
    #[error("no plugin manifest in this source")]
    ManifestMissing,

    /// 这个字符串不能当一个路径段用。
    #[error("unsafe path segment")]
    UnsafeSegment,

    /// 认领了一个不存在的暂存目录。
    #[error("staging directory does not exist")]
    StagingMissing,
}

/// Convenience alias used throughout the crate.
pub type Result<T> = std::result::Result<T, ExtensionError>;
