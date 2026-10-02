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

    /// 键值形态的本地偏好（agents.json 一类）。设置是 JSON 文件，读写失败与别的 IO
    /// 失败归一类：用户拿得去修正的理由都是「那个文件」。
    #[error("Store error: {0}")]
    Store(String),

    #[error("Agent CLI error: {0}")]
    AgentCli(String),

    /// 内置 Python 内核这条线上的失败：本机不支持、下不动、解不开、写不进设置。
    /// 与 agent 自己的拒绝分开：它不是某次 agent 调用的裁决。
    #[error("Python kernel error: {0}")]
    Python(String),

    #[error("Git error: {0}")]
    Git(String),
}

pub type Result<T> = std::result::Result<T, Error>;

/// 跨语言边界的唯一错误形状：Problem 由 ipc::problem 的那一处映射造出来，这里只把它
/// 序列化成 JSON 值，供 transport 结算成 {"error": ...} 信封。
impl Error {
    #[must_use]
    pub fn envelope(&self) -> serde_json::Value {
        serde_json::to_value(poietica_problem::Problem::from(self))
            .unwrap_or(serde_json::Value::Null)
    }
}

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
                "投递结果未确认，请先核对会话；仅支持幂等键的投递会自动恢复。".to_owned(),
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

/// 内置 Python 内核那条线的 typed error 折成一句人话。它自己的变体很多，但界面上要做的
/// 决定只有一条：让用户看见原因（哪一步、哪个文件、上游答了什么）。
impl From<poietica_python_native::PythonError> for Error {
    fn from(error: poietica_python_native::PythonError) -> Self {
        Self::Python(error.to_string())
    }
}

impl From<poietica_conversation_runtime::journal::JournalError> for Error {
    fn from(error: poietica_conversation_runtime::journal::JournalError) -> Self {
        log::error!("conversation journal failed: {error}");
        Self::Internal("the conversation journal is unavailable".to_owned())
    }
}
