use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error(transparent)]
    Automation(#[from] poietica_automation::AutomationError),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    /// SQLite 的拒绝消息不含路径与用户名，可原样透给界面：它是唯一说得出哪条语句被拒的。
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

    #[error("Agent CLI error: {0}")]
    AgentCli(String),

    #[error("Git error: {0}")]
    Git(String),
}

pub type Result<T> = std::result::Result<T, Error>;

impl From<poietica_ledger::LedgerError> for Error {
    fn from(error: poietica_ledger::LedgerError) -> Self {
        match error {
            poietica_ledger::LedgerError::Automation(cause) => Self::Automation(cause),
            cause => {
                log::error!("the local index rejected a statement: {cause}");
                Self::Persistence(cause.to_string())
            }
        }
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
            DeliveryError::Ledger(_)
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
