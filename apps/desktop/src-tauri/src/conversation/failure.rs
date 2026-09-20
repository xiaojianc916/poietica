//! 把 agent 那侧的失败折进这个程序既有的错误面。

use super::POISONED;
use crate::error::Error;
use poietica_conversation_runtime::RuntimeError;
use poietica_kap_client::{KapError, Refusal};

/// 全是本仓的字面量常量，不拼任何 agent 回话、外部输入或系统错误，故可原样上屏。
const fn refusal(reason: Refusal) -> &'static str {
    match reason {
        Refusal::UnknownSession => "这条对话的会话已经失效，请重新打开它",
        Refusal::Gone => "agent 已经退出，请重新发起对话",
    }
}

/// 本仓字面量的拒绝原样上屏；agent 报回的原话先落日志再原样上屏——桌面单机里确切的原话最有用。
pub(super) fn translate(error: KapError) -> Error {
    match error {
        KapError::Io(cause) => Error::Io(cause),
        KapError::Refused(reason) => Error::AgentCli(refusal(reason).to_owned()),
        other => {
            log::error!("the agent request failed: {other}");

            Error::AgentCli(other.to_string())
        }
    }
}

impl From<poietica_conversation_runtime::SessionError<Error>> for Error {
    fn from(error: poietica_conversation_runtime::SessionError<Error>) -> Self {
        use poietica_conversation_runtime::SessionError;
        match error {
            SessionError::Catalog(cause) => cause,
            SessionError::InvalidId => {
                Self::Validation("invalid conversation identifier".to_owned())
            }
            SessionError::Unbound => Self::NotFound("该对话尚未建立 agent 会话".to_owned()),
            SessionError::Missing => Self::NotFound(super::NO_SUCH_CONVERSATION.to_owned()),
            SessionError::WrongOwner => Self::Validation(
                "该对话不属于当前 agent；请切回原 agent，或明确新建对话。".to_owned(),
            ),
            SessionError::Agent(cause) => translate(cause),
            SessionError::RestoreCleanup { cause, cleanup } => {
                log::error!("failed to release a failed session subscription: {cleanup}");
                translate(cause)
            }
            SessionError::AttachCleanup { cause, cleanup } => {
                log::error!("failed to archive an unbound newly created session: {cleanup}");
                cause
            }
        }
    }
}

impl From<poietica_conversation_runtime::CommandError<Error>> for Error {
    fn from(error: poietica_conversation_runtime::CommandError<Error>) -> Self {
        use poietica_conversation_runtime::CommandError;
        match error {
            CommandError::Persistence(cause)
            | CommandError::Runtime(cause)
            | CommandError::Attachments(cause)
            | CommandError::Delivery(cause) => cause,
            CommandError::Session(cause) => Self::from(cause),
            CommandError::Agent(cause) => translate(cause),
            CommandError::Catalog(cause) => Self::from(cause),
            CommandError::Interaction(cause) => Self::NotFound(cause.to_string()),
            CommandError::ResponseClosed => Self::Internal(super::NO_ANSWER.to_owned()),
            CommandError::Readback => Self::Internal(super::dto::NO_THREAD.to_owned()),
            CommandError::ExportChanged => {
                Self::NotFound("导出来源已变化，请重新打开对话后再导出".to_owned())
            }
            CommandError::BindingUncertain {
                cause,
                verification,
            } => {
                log::error!(
                    "fork binding was not confirmed: {cause}; verification failed: {verification}"
                );
                Self::Persistence(
                    "分叉结果尚未确认，请先刷新对话列表；未冒险清理远端会话".to_owned(),
                )
            }
            CommandError::EmptyPrompt => Self::Validation("the prompt is empty".to_owned()),
            CommandError::AttachmentSetChanged => Self::Asset(
                "attachment preparation changed the submitted attachment set".to_owned(),
            ),
            CommandError::MissingReceipt => {
                Self::Internal("a fresh admission was already settled".to_owned())
            }
            CommandError::MissingSession => Self::NotFound(super::NO_SESSION.to_owned()),
        }
    }
}

impl From<poietica_conversation_runtime::catalog::CatalogError> for Error {
    fn from(error: poietica_conversation_runtime::catalog::CatalogError) -> Self {
        use poietica_conversation_runtime::catalog::CatalogError;
        match error {
            CatalogError::InvalidId => {
                Self::Validation("invalid conversation identifier".to_owned())
            }
            CatalogError::EmptyTitle => {
                Self::Validation("the conversation name is empty".to_owned())
            }
            CatalogError::Missing => {
                Self::NotFound("that conversation no longer exists".to_owned())
            }
        }
    }
}

impl From<RuntimeError> for Error {
    fn from(error: RuntimeError) -> Self {
        match error {
            RuntimeError::Agent(error) => translate(error),
            RuntimeError::Gone => translate(KapError::Refused(Refusal::Gone)),
            RuntimeError::Busy => Self::Automation(poietica_automation::AutomationError::Data(
                "另一代理正在使用连接；后台任务不会中断它".to_owned(),
            )),
            RuntimeError::Poisoned => Self::Internal(POISONED.to_owned()),
            error => {
                log::error!("conversation lifecycle failed: {error}");
                Self::Internal(
                    "the conversation connection could not complete its lifecycle".to_owned(),
                )
            }
        }
    }
}
