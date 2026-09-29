use crate::session::SessionError;
use poietica_agent_client::AgentError;
use std::error::Error;

#[derive(Debug, thiserror::Error)]
pub enum CommandError<E: Error + 'static> {
    #[error("connection preparation failed: {0}")]
    Runtime(#[source] E),
    #[error(transparent)]
    Session(SessionError<E>),
    #[error("attachment preparation failed: {0}")]
    Attachments(#[source] E),
    #[error(transparent)]
    Agent(AgentError),
    #[error("submission failed: {0}")]
    Delivery(#[source] E),
    #[error("the prompt is empty")]
    EmptyPrompt,
    #[error("attachment preparation changed the submitted attachment set")]
    AttachmentSetChanged,
    #[error("the submission returned no new receipt")]
    MissingReceipt,
    #[error("no agent session is running")]
    MissingSession,
    #[error(transparent)]
    Catalog(crate::catalog::CatalogError),
    #[error("conversation persistence failed: {0}")]
    Persistence(#[source] E),
    #[error(transparent)]
    Interaction(AgentError),
    #[error("the agent dropped a response")]
    ResponseClosed,
    #[error("the committed conversation could not be read back")]
    Readback,
    /* 导出与分享共用：两者都在拿到会话绑定之后才动它，而那段间隙里用户可能已经换了绑定。 */
    #[error("the thread binding changed before the session could be read")]
    ExportChanged,
    #[error("fork binding failed: {cause}; binding verification failed: {verification}")]
    BindingUncertain {
        #[source]
        cause: E,
        verification: E,
    },
}
