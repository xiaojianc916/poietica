use thiserror::Error;

/// 插件字节与官方安装账本这一路可能出的事。
#[derive(Debug, Error)]
pub enum HostError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("archive error: {0}")]
    Archive(#[from] zip::result::ZipError),

    #[error("walk error: {0}")]
    Walk(#[from] walkdir::Error),

    #[error("path prefix error: {0}")]
    Prefix(#[from] std::path::StripPrefixError),

    #[error("invalid plugin ledger: {0}")]
    InvalidLedger(String),

    #[error("plugin is absent from the ledger: {0}")]
    PluginMissing(String),

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

pub type Result<T> = std::result::Result<T, HostError>;
