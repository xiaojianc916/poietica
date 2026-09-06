use super::{Handle, Runtime, RuntimeFailure, Takeover};
use crate::{
    gateway::KapGateway,
    session::{SessionError, SessionMode, SessionRequest},
    submission::{Submission, submit},
};
use poietica_conversation::{identity::TurnId, turn::SkillSpec};
use poietica_kap_client::{
    ConfigControl, ConfigSelection, KapError, SessionEvent, apply_configurations, select_config,
};
use poietica_ledger::{LedgerError, index::ThreadAttachment};
use std::{error::Error, fmt, future::Future};
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum CommandError<E: Error + 'static> {
    #[error("connection preparation failed: {0}")]
    Runtime(#[source] E),
    #[error(transparent)]
    Session(SessionError<E>),
    #[error("attachment preparation failed: {0}")]
    Attachments(#[source] E),
    #[error(transparent)]
    Agent(KapError),
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
    Interaction(KapError),
    #[error("the agent dropped a response")]
    ResponseClosed,
    #[error("the committed conversation could not be read back")]
    Readback,
    #[error("the export source changed while choosing a destination")]
    ExportChanged,
    #[error("fork binding failed: {cause}; binding verification failed: {verification}")]
    BindingUncertain {
        #[source]
        cause: E,
        verification: E,
    },
}

pub struct Prompt<A> {
    pub agent_id: String,
    pub cwd: Option<String>,
    pub takeover: Takeover,
    pub thread_id: Uuid,
    pub turn: TurnId,
    pub text: String,
    pub configuration: Vec<ConfigSelection>,
    pub assets: Vec<A>,
    pub skills: Vec<SkillSpec>,
}
impl<A> fmt::Debug for Prompt<A> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Prompt")
            .field("thread_id", &self.thread_id)
            .field("turn", &self.turn)
            .field("attachments", &self.assets.len())
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
pub struct PromptReceipt {
    pub session_id: String,
    pub prompt_id: String,
}

impl<E: RuntimeFailure> Runtime<E> {
    pub async fn prompt<A, P, PF, V, C>(
        &self,
        request: Prompt<A>,
        prepare_assets: P,
        validate: V,
        submitted_at: C,
    ) -> Result<PromptReceipt, CommandError<E>>
    where
        A: Send + 'static,
        P: FnOnce(Uuid, Vec<A>) -> PF + Send,
        PF: Future<Output = Result<Vec<ThreadAttachment>, E>> + Send,
        V: FnOnce(&poietica_ledger::index::AgentStore) -> Result<(), LedgerError> + Send + 'static,
        C: FnOnce() -> i64 + Send,
    {
        if request.text.trim().is_empty() && request.assets.is_empty() {
            return Err(CommandError::EmptyPrompt);
        }
        let live = self
            .ensure(request.agent_id, request.cwd, request.takeover)
            .await
            .map_err(CommandError::Runtime)?;
        let named = request.thread_id.to_string();
        let held = self
            .inner
            .sessions
            .resolve(
                &self.inner.index,
                &live.client,
                &live.book,
                SessionRequest {
                    owner: &live.agent_id,
                    default_root: self.root(),
                    named: &named,
                    mode: SessionMode::CreateIfUnbound,
                },
            )
            .await
            .map_err(CommandError::Session)?;
        let expected_attachments = request.assets.len();
        let attachments = prepare_assets(held.thread_id, request.assets)
            .await
            .map_err(CommandError::Attachments)?;
        if attachments.len() != expected_attachments {
            return Err(CommandError::AttachmentSetChanged);
        }
        let session_id = held.session_id.clone();
        let model = request
            .configuration
            .iter()
            .find(|selection| selection.id == "model")
            .map(|selection| selection.value.clone())
            .unwrap_or_default();
        if !request.configuration.is_empty() {
            let controls = apply_configurations(
                &live.client,
                session_id.clone(),
                request.configuration,
                Some(request.text.clone()),
            )
            .await
            .map_err(CommandError::Agent)?;
            self.announce(&live, session_id.clone(), controls).await;
        }
        let gateway = KapGateway {
            client: live.client.clone(),
            journal: self.journal().clone(),
            attachments_root: self.inner.attachments.clone(),
        };
        // The lease spans configuration, durable admission and acknowledgement.
        let prompt_id = submit(
            &self.inner.index,
            gateway,
            Submission {
                thread: held.thread_id,
                session: session_id.clone(),
                turn: request.turn,
                text: request.text,
                model,
                attachments,
                skills: request.skills,
                submitted_at_unix_millis: submitted_at(),
            },
            validate,
        )
        .await
        .map_err(CommandError::Delivery)?
        .ok_or(CommandError::MissingReceipt)?;
        drop(held);
        Ok(PromptReceipt {
            session_id,
            prompt_id,
        })
    }

    pub async fn select_configuration(
        &self,
        thread_id: Option<String>,
        config_id: String,
        value: String,
        input: Option<String>,
    ) -> Result<Vec<ConfigControl>, CommandError<E>> {
        let live = self
            .current()
            .map_err(CommandError::Runtime)?
            .ok_or(CommandError::MissingSession)?;
        let held = match thread_id.as_deref() {
            Some(named) => Some(
                self.inner
                    .sessions
                    .resolve(
                        &self.inner.index,
                        &live.client,
                        &live.book,
                        SessionRequest {
                            owner: &live.agent_id,
                            default_root: self.root(),
                            named,
                            mode: SessionMode::CreateIfUnbound,
                        },
                    )
                    .await
                    .map_err(CommandError::Session)?,
            ),
            None => None,
        };
        let addressed = held
            .as_ref()
            .map_or_else(|| live.anchor.clone(), |held| held.session_id.clone());
        let controls = select_config(&live.client, addressed.clone(), config_id, value, input)
            .await
            .map_err(CommandError::Agent)?;
        self.announce(&live, addressed, controls.clone()).await;
        drop(held);
        Ok(controls)
    }

    async fn announce(&self, live: &Handle, session_id: String, controls: Vec<ConfigControl>) {
        match live.client.goal(session_id.clone()).await {
            Ok(goal) => (self.inner.publish)(SessionEvent::Selectors {
                session_id,
                controls,
                goal,
            }),
            Err(error) => {
                // Reporting failure does not undo an already accepted configuration.
                log::warn!(
                    "could not report the session goal after a configuration change: {error}"
                );
            }
        }
    }
}
