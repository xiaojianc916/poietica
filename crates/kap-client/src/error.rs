use thiserror::Error;

#[derive(Debug, Error)]
#[error("the frame does not fit the pinned contract: {0}")]
pub struct DecodeError(#[from] serde_json::Error);

#[derive(Debug, Error)]
pub enum EnvelopeError {
    #[error("the server refused with code {code}: {msg}")]
    Refused { code: i64, msg: String },
    #[error("the envelope data does not fit the pinned contract: {0}")]
    Shape(#[from] serde_json::Error),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    UnknownSession,
    Gone,
}

#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum KapError {
    #[error("the agent command could not be started: {message}")]
    Spawn { message: String },
    #[error("timed out: {message}")]
    Timeout { message: String },
    #[error("kap transport error: {message}")]
    Transport { message: String },
    /// 码是 kap 的（protocol/error-codes.ts），原样带出来 —— 压成一句话后没有人判得动它。
    #[error("kap answered code {code}: {message}")]
    Envelope { code: i64, message: String },
    #[error("kap handshake failed: {message}")]
    Handshake { message: String },
    #[error("the request was refused before it was sent: {0:?}")]
    Refused(Refusal),
    #[error("invalid request: {message}")]
    Validation { message: String },
    #[error("the permission answer was refused: {message}")]
    Permission { message: String },

    #[error("the question answer was refused: {message}")]
    Question { message: String },
    /// message 是已经可以说给用户听的话（带上下文、无敏感细节），宿主原样上屏。
    #[error("{message}")]
    Toolchain { message: String },
    #[error("session export file error: {0}")]
    Io(#[from] std::io::Error),

    #[error("a lock was left held by a panicking task")]
    Poisoned,
}

pub type Result<T> = core::result::Result<T, KapError>;
