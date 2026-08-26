use serde::Serialize;
use specta::Type;
use std::borrow::Cow;
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

#[derive(Clone, Copy, Debug, Serialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum IpcErrorCode {
    Validation,
    NotFound,
    PermissionDenied,
    Persistence,
    Plugin,
    Asset,
    Platform,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IpcError {
    pub code: IpcErrorCode,
    pub message: String,
    pub recoverable: bool,
}

impl Error {
    fn to_ipc_error(&self) -> IpcError {
        IpcError {
            code: self.code(),
            message: self.public_message().into_owned(),
            recoverable: self.recoverable(),
        }
    }

    fn code(&self) -> IpcErrorCode {
        match self {
            Self::NotFound(_) => IpcErrorCode::NotFound,
            Self::Persistence(_) | Self::File(_) | Self::Io(_) => IpcErrorCode::Persistence,
            Self::Plugin(_) => IpcErrorCode::Plugin,
            Self::Asset(_) => IpcErrorCode::Asset,
            /* 参数无效与 agent 拒绝在 IPC 上是同一码：都是这次请求本身不成立。 */
            Self::Validation(_) | Self::AgentCli(_) | Self::Git(_) => IpcErrorCode::Validation,
            _ => IpcErrorCode::Platform,
        }
    }

    fn recoverable(&self) -> bool {
        matches!(
            self,
            Self::Io(_)
                | Self::Persistence(_)
                | Self::File(_)
                | Self::NotFound(_)
                | Self::AgentCli(_)
                | Self::Git(_)
        )
    }
}

// the public message table is kept in its own block, apart from the IPC mapping
impl Error {
    /// 返回给 `WebView` 的稳定、脱敏错误消息。
    ///
    /// 不得在这里使用 `self.to_string()`、底层 `source` 或文件路径：
    /// Rust/Tauri/插件错误可能包含绝对路径、用户名、权限信息或系统细节。
    ///
    /// `AgentCli` 与 `Git` 是仅有的例外，原样透出自己的消息 —— 理由见那个变体的
    /// 文档。用 `Cow` 而不是把整张表改成 `String`：其余分支仍然是借用，一个
    /// 字节都不多分配。
    ///
    /// 这个返回类型本身曾经是个问题。它是 `&'static str`，于是「带具体原因
    /// 的错误」在类型上就无法到达界面：白名单拒绝时明明写了拒绝的理由，界面
    /// 上只会看到「应用操作失败」。
    fn public_message(&self) -> Cow<'static, str> {
        match self {
            Self::Validation(_) => Cow::Borrowed("请求参数无效"),
            Self::NotFound(_) => Cow::Borrowed("请求的资源不存在"),

            Self::Store(_) => Cow::Borrowed("配置文件读写失败"),
            Self::Io(_) | Self::File(_) => Cow::Borrowed("文件操作失败"),

            Self::SerdeJson(_) => Cow::Borrowed("数据格式无效"),

            Self::Asset(_) => Cow::Borrowed("资源处理失败"),

            Self::Plugin(_) => Cow::Borrowed("插件操作失败"),

            Self::Persistence(reason) | Self::AgentCli(reason) | Self::Git(reason) => {
                Cow::Owned(reason.clone())
            }

            Self::Tauri(_) | Self::Internal(_) => Cow::Borrowed("应用操作失败"),
        }
    }
}

impl From<Error> for IpcError {
    fn from(error: Error) -> Self {
        error.to_ipc_error()
    }
}

impl Serialize for Error {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        self.to_ipc_error().serialize(serializer)
    }
}

pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        clippy::unwrap_used,
        clippy::panic,
        clippy::indexing_slicing,
        clippy::shadow_unrelated,
        reason = "tests operate on known-good fixtures; a broken assumption must fail the test loudly"
    )]

    use super::{Error, IpcErrorCode};

    #[test]
    fn validation_error_has_validation_ipc_mapping() {
        let error = Error::Validation("invalid input".to_owned());

        assert!(matches!(error.code(), IpcErrorCode::Validation));
        assert!(!error.recoverable());
    }

    #[test]
    fn io_error_is_recoverable_persistence_error() {
        let error = Error::Io(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "denied",
        ));

        assert!(matches!(error.code(), IpcErrorCode::Persistence));
        assert!(error.recoverable());
    }

    #[test]
    fn serialized_error_preserves_ipc_contract() {
        let value = serde_json::to_value(Error::Validation("invalid settings".to_owned()))
            .expect("error should serialize");

        assert_eq!(value["code"], "validation");
        assert_eq!(value["message"], "请求参数无效");
        assert_eq!(value["recoverable"], false);
    }

    #[test]
    fn serialized_io_error_does_not_leak_path_or_native_error() {
        let error = Error::Io(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "permission denied for /Users/example/private/secret.txt",
        ));

        let value = serde_json::to_value(error).expect("error should serialize");
        let message = value["message"]
            .as_str()
            .expect("serialized error message should be a string");

        assert_eq!(message, "文件操作失败");
        assert!(!message.contains("/Users/"));
        assert!(!message.contains("secret.txt"));
        assert!(!message.contains("permission denied"));
    }

    /*
     * 与上一条相反：这个变体存在的意义就是原因要能出去。少了它，下一个人
     * 看到「脱敏」两个字，很可能顺手把它也改回固定文案。
     */
    #[test]
    fn agent_cli_error_carries_its_own_reason() {
        let error = Error::AgentCli(
            "只允许 provider list / add / remove / catalog list / catalog add".to_owned(),
        );

        let value = serde_json::to_value(error).expect("error should serialize");

        assert_eq!(value["code"], "validation");
        assert_eq!(
            value["message"],
            "只允许 provider list / add / remove / catalog list / catalog add"
        );
        assert_eq!(value["recoverable"], true);
    }
}
