mod configuration;
mod control;
mod failure;
mod prompt;
mod queries;
mod threads;
pub use control::SessionAction;
pub use failure::CommandError;
pub use prompt::{Prompt, PromptReceipt};
pub use threads::{
    DeletedThread, ExportSource, ForkThread, OpenThread, OpenedThread, ThreadTarget,
};

use crate::{
    DeliveryError,
    connection::{ConnectionOwner, Handle, LaunchRequest, Preparation, RuntimeError, Takeover},
    gateway::KapGateway,
    journal::{FrameJournal, JournalError},
    session::SessionResolver,
};
use poietica_kap_client::SessionEvent;
use poietica_ledger::execution::{IndexError, LocalIndex};
use std::{error::Error, fmt, path::PathBuf, sync::Arc};

pub trait RuntimeFailure:
    Error
    + From<IndexError>
    + From<DeliveryError>
    + From<JournalError>
    + From<RuntimeError>
    + Send
    + 'static
{
}
impl<T> RuntimeFailure for T where
    T: Error
        + From<IndexError>
        + From<DeliveryError>
        + From<JournalError>
        + From<RuntimeError>
        + Send
        + 'static
{
}

/// Public use cases do not expose connection handles or identity machinery.
///
/// ```compile_fail
/// use poietica_conversation_runtime::session::SessionResolver;
/// ```
///
/// ```compile_fail
/// use poietica_conversation_runtime::{Runtime, RuntimeFailure};
/// fn bypass<E: RuntimeFailure>(runtime: &Runtime<E>) { let _ = &runtime.connection; }
/// ```
///
/// ```compile_fail
/// use poietica_conversation_runtime::{Runtime, RuntimeFailure, Takeover};
/// async fn bypass<E: RuntimeFailure>(runtime: &Runtime<E>) {
///     let _ = runtime.ensure("agent".to_owned(), None, Takeover::Replace).await;
/// }
/// ```
pub struct Runtime<E: RuntimeFailure> {
    root: PathBuf,
    attachments: PathBuf,
    index: LocalIndex<E>,
    journal: FrameJournal,
    sessions: Arc<SessionResolver>,
    publish: Arc<dyn Fn(SessionEvent) + Send + Sync>,
    connection: Arc<ConnectionOwner<E>>,
}
impl<E: RuntimeFailure> fmt::Debug for Runtime<E> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ConversationRuntime")
            .finish_non_exhaustive()
    }
}
impl<E: RuntimeFailure> Runtime<E> {
    pub fn new(
        root: PathBuf,
        attachments: PathBuf,
        index: LocalIndex<E>,
        journal: FrameJournal,
        prepare: impl Fn(LaunchRequest) -> Preparation<E> + Send + Sync + 'static,
        publish: impl Fn(SessionEvent) + Send + Sync + 'static,
    ) -> Self {
        let sessions = Arc::new(SessionResolver::default());
        let publish: Arc<dyn Fn(SessionEvent) + Send + Sync> = Arc::new(publish);
        let recording_index = index.clone();
        let recording_publish = Arc::clone(&publish);
        let recovery_index = index.clone();
        let recovery_sessions = Arc::clone(&sessions);
        let recovery_journal = journal.clone();
        let recovery_attachments = attachments.clone();
        let connection = Arc::new(ConnectionOwner::new(
            prepare,
            move |event_book, event| {
                let event_index = recording_index.clone();
                let publish = Arc::clone(&recording_publish);
                Box::pin(async move {
                    if let Err(error) =
                        crate::events::record(&event_index, &event_book, &event).await
                    {
                        log::warn!("could not persist an agent session event: {error}");
                    }
                    publish(event);
                })
            },
            move |live, maintenance_stop| {
                let maintenance_index = recovery_index.clone();
                let sessions = Arc::clone(&recovery_sessions);
                let journal = recovery_journal.clone();
                let attachments = recovery_attachments.clone();
                Box::pin(async move {
                    match crate::disposal::discharge(
                        &maintenance_index,
                        &live.agent_id,
                        &live.anchor,
                        |session| live.client.delete_session(session),
                        || !maintenance_stop.is_cancelled(),
                    )
                    .await
                    {
                        Ok(failures) => {
                            for failure in failures {
                                log::warn!(
                                    "session {} remains pending archive: {}",
                                    failure.session_id,
                                    failure.cause
                                );
                            }
                        }
                        Err(error) => log::warn!("could not update the disposal ledger: {error}"),
                    }
                    let gateway = KapGateway {
                        client: live.client.clone(),
                        journal,
                        attachments_root: attachments,
                    };
                    match crate::delivery::recover(
                        &maintenance_index,
                        gateway,
                        &live.agent_id,
                        &sessions,
                    )
                    .await
                    {
                        Ok(failures) => {
                            for failure in failures {
                                log::warn!(
                                    "delivery {} remains unresolved: {}",
                                    failure.turn,
                                    failure.failure
                                );
                            }
                        }
                        Err(error) => log::warn!("could not read pending deliveries: {error}"),
                    }
                })
            },
        ));
        Self {
            root,
            attachments,
            index,
            journal,
            sessions,
            publish,
            connection,
        }
    }
    fn root(&self) -> &PathBuf {
        &self.root
    }
    pub fn attachments(&self) -> &PathBuf {
        &self.attachments
    }
    fn journal(&self) -> &FrameJournal {
        &self.journal
    }
    fn sessions(&self) -> &SessionResolver {
        &self.sessions
    }
    async fn ensure(
        &self,
        agent: String,
        cwd: Option<String>,
        takeover: Takeover,
    ) -> Result<Handle, E> {
        let cwd = cwd.map_or_else(|| self.root.clone(), PathBuf::from);
        Arc::clone(&self.connection)
            .open(agent, cwd, takeover)
            .await
    }
    pub async fn disconnect(&self) -> Result<(), E> {
        let connection = Arc::clone(&self.connection);
        let journal = self.journal.clone();
        tokio::task::spawn_blocking(move || {
            let drained = connection.stop(false)?;
            journal.flush().map_err(E::from)?;
            drained.result()
        })
        .await
        .map_err(|error| E::from(RuntimeError::Worker(error.to_string())))?
    }
    pub fn shutdown(&self) -> Result<(), E> {
        let drained = self.connection.stop(true)?;
        self.journal.close().map_err(E::from)?;
        drained.result()
    }
    pub async fn apply_daemon_intent(&self, running: bool) -> Result<(), E> {
        self.connection.set_intent(running)?;
        if !running {
            self.disconnect().await?;
        }
        Ok(())
    }
}
impl<E: RuntimeFailure> Drop for Runtime<E> {
    fn drop(&mut self) {
        if let Err(error) = self.shutdown() {
            log::error!("conversation runtime could not shut down cleanly: {error}");
        }
    }
}
#[cfg(test)]
mod tests;
