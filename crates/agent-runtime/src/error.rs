/// 这一侧自己判定的拒绝。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// 这个会话号不是本次连接开出来的。
    UnknownSession,
    /// 驱动器已经停了，没有谁能收下这条命令。
    Gone,
    /// 这条会话上已经有一轮在飞。
    Busy,
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
    /// 握手没能走完，一条会话都没开出来。
    #[error("kap handshake failed: {message}")]
    Handshake { message: String },
    /// 这一侧拒绝了请求，它还没有被发出去。
    #[error("the request was refused before it was sent: {0:?}")]
    Refused(Refusal),
    /// A task panicked while holding the run slot.
    #[error("the run slot was left locked by a panicking task")]
    Poisoned,
    /// JSON 编解码失败。
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

// 公共 API 别名，调用侧不感知底层变化。
pub type AcpError = KapError;

/// The result type used throughout this crate.
pub type Result<T> = core::result::Result<T, KapError>;
