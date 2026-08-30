//! 两族错误：解码（帧不认识、信封拒绝）与驱动（起进程、握手、传输、本地拒绝）。

use thiserror::Error;

/// 一条字节流不是这个协议认识的帧。
#[derive(Debug, Error)]
#[error("the frame does not fit the pinned contract: {0}")]
pub struct DecodeError(#[from] serde_json::Error);

/// 信封收下了但业务拒绝：非零 code 是 server 的裁决，不是传输故障。
#[derive(Debug, Error)]
pub enum EnvelopeError {
    #[error("the server refused with code {code}: {msg}")]
    Refused { code: i64, msg: String },
    #[error("the envelope data does not fit the pinned contract: {0}")]
    Shape(#[from] serde_json::Error),
}

/// 这一侧自己判定的拒绝。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// 这个会话号不是本次连接开出来的。
    UnknownSession,
    /// 驱动器已经停了，没有谁能收下这条命令。
    Gone,
}

/// Everything that can go wrong while driving a kap agent.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum KapError {
    /// The agent command could not be turned into a process.
    #[error("the agent command could not be started: {message}")]
    Spawn { message: String },
    /// kap server 没能在规定时间内注册到实例目录。
    #[error("kap server did not start in time: {message}")]
    Timeout { message: String },
    /// REST 或 WebSocket 层报了错。
    #[error("kap transport error: {message}")]
    Transport { message: String },
    /// 对端回了一个非零 code 的信封。码是 kap 的（protocol/error-codes.ts），
    /// 原样带出来 —— 压成一句话之后没有人再判得动它。
    #[error("kap answered code {code}: {message}")]
    Envelope { code: i64, message: String },
    /// 握手没能走完，一条会话都没开出来。
    #[error("kap handshake failed: {message}")]
    Handshake { message: String },
    /// 这一侧拒绝了请求，它还没有被发出去。
    #[error("the request was refused before it was sent: {0:?}")]
    Refused(Refusal),
    /// 本地领域校验失败，请求尚未发给 Kimi。
    #[error("invalid request: {message}")]
    Validation { message: String },
    /// 答复与桌上的问题对不上：没问过、没这个选项、或问的那一侧已经走了。
    #[error("the permission answer was refused: {message}")]
    Permission { message: String },

    /// 一组答复与桌上的题对不上：题号不在这一组、有题没答、选项没提供过、多选
    /// 答给了单选题，或问的那一侧已经走了。
    #[error("the question answer was refused: {message}")]
    Question { message: String },
    /// agent 工具链（config.toml 读写、包管理器）这一路的失败。message 是已经
    /// 可以说给用户听的话 —— 带上下文、无敏感细节，宿主原样上屏。
    #[error("{message}")]
    Toolchain { message: String },
    /// A task panicked while holding one of this crate's locks.
    #[error("a lock was left held by a panicking task")]
    Poisoned,
}

/// The result type used throughout this crate.
pub type Result<T> = core::result::Result<T, KapError>;
