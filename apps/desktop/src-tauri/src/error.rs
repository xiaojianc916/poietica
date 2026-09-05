use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    /// 本地索引库拒绝了一条语句。消息原样透给界面，判据与 AgentCli 同一条。
    ///
    /// SQLite 说的是「no such table: run_events」「UNIQUE constraint failed:
    /// threads.session_id」这一类话：不含路径、不含用户名，而且它是唯一说得出
    /// 到底哪一句被拒的东西。折成一句「本地索引库写入失败」之后，屏幕上、日志
    /// 之外就再没有任何人知道发生了什么。
    #[error("Persistence error: {0}")]
    Persistence(String),

    #[error("JSON error: {0}")]
    SerdeJson(#[from] serde_json::Error),

    #[error("Tauri error: {0}")]
    Tauri(#[from] tauri::Error),

    #[error("Store error: {0}")]
    Store(#[from] tauri_plugin_store::Error),

    #[error("Validation error: {0}")]
    Validation(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Internal error: {0}")]
    Internal(String),

    #[error("Plugin error: {0}")]
    Plugin(String),

    #[error("Asset error: {0}")]
    Asset(String),

    #[error("File error: {0}")]
    File(String),

    /// 受控 agent CLI 调用被拒或失败，或 agent 自己说明了失败的原因。
    ///
    /// 它与 Git 是仅有的两个消息原样透给界面的变体。
    ///
    /// 判据是：这是一个桌面单机应用。屏幕前的人就是跑这个 agent 进程
    /// 的本机用户，agent 对他说的话不是秘密，而是他唯一拿得去排查的东西。
    ///
    /// 而「为什么被拒」恰恰是用户唯一能据以修正的信息。换成一句「应用操作
    /// 失败」，等于让人去猜。
    #[error("Agent CLI error: {0}")]
    AgentCli(String),

    /// git CLI 拒绝或失败。与 AgentCli 同一判据：理由原样透给界面，
    /// 那是用户唯一拿得去修正的信息（分支重名、工作区不干净……）。
    #[error("Git error: {0}")]
    Git(String),
}

pub type Result<T> = std::result::Result<T, Error>;

impl From<poietica_ledger::LedgerError> for Error {
    fn from(error: poietica_ledger::LedgerError) -> Self {
        log::error!("the local index rejected a statement: {error}");
        Self::Persistence(error.to_string())
    }
}

impl From<poietica_ledger::execution::IndexError> for Error {
    fn from(error: poietica_ledger::execution::IndexError) -> Self {
        match error {
            poietica_ledger::execution::IndexError::Storage(cause) => Self::from(cause),
            cause => Self::Internal(cause.to_string()),
        }
    }
}

impl From<poietica_conversation_runtime::DeliveryError> for Error {
    fn from(failure: poietica_conversation_runtime::DeliveryError) -> Self {
        use poietica_conversation_runtime::DeliveryError;
        log::error!("conversation delivery failed: {failure}");
        match failure {
            DeliveryError::Index(error) => Self::from(error),
            DeliveryError::Rejected(_) => {
                Self::AgentCli("消息未被代理接收，请检查会话后重试。".to_owned())
            }
            DeliveryError::Indeterminate(_) | DeliveryError::UnsafeReplay(_) => Self::AgentCli(
                "投递结果未确认，请先核对会话；不要重复发送。仅支持幂等键的投递会自动恢复。"
                    .to_owned(),
            ),
            DeliveryError::Domain(_)
            | DeliveryError::Ledger(_)
            | DeliveryError::MissingAdmission(_)
            | DeliveryError::Identity(_) => {
                Self::Internal("无法完成投递记账；请保留现场并查看诊断日志。".to_owned())
            }
        }
    }
}

impl From<poietica_asset::blob::BlobError> for Error {
    fn from(error: poietica_asset::blob::BlobError) -> Self {
        use poietica_asset::blob::BlobError;
        match error {
            BlobError::Io(cause) => Self::Io(cause),
            BlobError::InvalidHash => Self::Validation("invalid attachment digest".to_owned()),
            BlobError::Integrity | BlobError::Length => {
                Self::Asset("attachment content could not be verified".to_owned())
            }
        }
    }
}

impl From<poietica_conversation_runtime::journal::JournalError> for Error {
    fn from(error: poietica_conversation_runtime::journal::JournalError) -> Self {
        log::error!("conversation journal failed: {error}");
        Self::Internal("the conversation journal is unavailable".to_owned())
    }
}
