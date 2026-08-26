use thiserror::Error;

/// Everything that can go wrong when reading or writing agent state.
///
/// 每一个变体对应一个真实且不同的失败源，没有一个万能兜底格。此前有七个，
/// 其中四个（凭据库、密钥编码、密钥长度、密钥不对）只为加密而存在；库不再
/// 加密，它们描述的处境也就不会再发生了。
#[derive(Debug, Error)]
pub enum StoreError {
    /// The database rejected a statement.
    #[error("database error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    /// A payload could not be encoded or decoded.
    #[error("payload error: {0}")]
    Json(#[from] serde_json::Error),

    /// The operating system could not provide a local UTC offset.
    #[error("local time offset is unavailable: {0}")]
    LocalOffset(#[from] time::error::IndeterminateOffset),

    /// A timestamp could not be formatted.
    #[error("timestamp error: {0}")]
    Time(#[from] time::error::Format),
}

/// Convenience alias used throughout the crate.
pub type Result<T> = std::result::Result<T, StoreError>;
