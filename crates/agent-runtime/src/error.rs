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
    /// REST 或 WebSocket 层报了错，或对端回了一个非零 code 的信封。
    #[error("kap transport error: {message}")]
    Transport { message: String },
    /// 握手没能走完，一条会话都没开出来。
    #[error("kap handshake failed: {message}")]
    Handshake { message: String },
    /// 这一侧拒绝了请求，它还没有被发出去。
    #[error("the request was refused before it was sent: {0:?}")]
    Refused(Refusal),
    /// 答复与桌上的问题对不上：没问过、没这个选项、或问的那一侧已经走了。
    #[error("the permission answer was refused: {message}")]
    Permission { message: String },
    /// A task panicked while holding one of this crate's locks.
    #[error("a lock was left held by a panicking task")]
    Poisoned,
    /// JSON 编解码失败。
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

/// The result type used throughout this crate.
pub type Result<T> = core::result::Result<T, KapError>;
