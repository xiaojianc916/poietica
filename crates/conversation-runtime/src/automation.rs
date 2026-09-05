//! Frozen automation input uses the conversation session lease and the ordinary admission pipeline.
use crate::{
    DeliveryError, Submission,
    gateway::KapGateway,
    journal::FrameJournal,
    session::{Held, SessionError, SessionResolver},
};
use poietica_automation::{AutomationError, Execution};
use poietica_conversation::identity::TurnId;
use poietica_kap_client::{
    AgentClient, ConfigSelection, KapError, PromptObservation, SessionBook, apply_configurations,
    observe_prompt,
};
use poietica_ledger::execution::{IndexError, LocalIndex, read_index, write_index};
use std::{error::Error, path::Path};

#[derive(Debug, thiserror::Error)]
pub enum ExecutionError<E: Error + 'static> {
    #[error("automation conversation persistence failed: {0}")]
    Catalog(#[source] E),
    #[error(transparent)]
    Session(SessionError<E>),
    #[error(transparent)]
    Agent(KapError),
    #[error(transparent)]
    Policy(AutomationError),
    #[error("automation was cancelled before admission")]
    Cancelled,
    #[error("automation submission returned no receipt identity")]
    MissingReceipt,
    #[error("no official session exists for this stop request")]
    MissingSession,
}

#[derive(Debug)]
pub struct Context<'a, E> {
    pub index: &'a LocalIndex<E>,
    pub client: &'a AgentClient,
    pub book: &'a SessionBook,
    pub owner: &'a str,
    pub sessions: &'a SessionResolver,
    pub journal: &'a FrameJournal,
    pub attachments_root: &'a Path,
}

impl<E> Context<'_, E>
where
    E: Error + From<IndexError> + From<DeliveryError> + Send + 'static,
{
    async fn resolve(&self, execution: &Execution) -> Result<Held, ExecutionError<E>> {
        if self.owner != execution.agent_id {
            return Err(ExecutionError::Session(SessionError::WrongOwner));
        }
        self.sessions
            .resolve(
                self.index,
                self.client,
                self.book,
                self.owner,
                Path::new(&execution.workspace_root),
                execution.thread_id().map_err(ExecutionError::Policy)?,
            )
            .await
            .map_err(ExecutionError::Session)
    }

    async fn existing(&self, execution: &Execution) -> Result<Option<Held>, ExecutionError<E>> {
        let thread = uuid::Uuid::parse_str(execution.thread_id().map_err(ExecutionError::Policy)?)
            .map_err(|_| ExecutionError::Session(SessionError::InvalidId))?;
        let stored = read_index(self.index, move |store| {
            store
                .thread(thread)
                .map_err(IndexError::from)
                .map_err(E::from)
        })
        .await
        .map_err(ExecutionError::Catalog)?
        .ok_or(ExecutionError::Session(SessionError::Missing))?;
        match (stored.session_id, stored.agent_id) {
            (None, None) => Ok(None),
            (Some(_), Some(owner)) if owner == execution.agent_id => {
                self.resolve(execution).await.map(Some)
            }
            _ => Err(ExecutionError::Session(SessionError::WrongOwner)),
        }
    }

    pub async fn submit(&self, execution: &Execution) -> Result<String, ExecutionError<E>> {
        let held = self.resolve(execution).await?;
        let configuration: Vec<_> = execution
            .session_config
            .iter()
            .map(|(id, value)| ConfigSelection {
                id: id.clone(),
                value: value.clone(),
            })
            .collect();
        if !configuration.is_empty() {
            apply_configurations(
                self.client,
                held.session_id.clone(),
                configuration,
                Some(execution.prompt.clone()),
            )
            .await
            .map_err(ExecutionError::Agent)?;
        }
        let run = execution.run.id.clone();
        let owned = write_index(self.index, move |store| {
            store
                .automation_execution(&run)
                .map_err(IndexError::from)
                .map_err(E::from)
        })
        .await
        .map_err(ExecutionError::Catalog)?;
        if owned.is_none_or(|owned| owned.cancel_requested) {
            return Err(ExecutionError::Cancelled);
        }
        let gateway = KapGateway {
            client: self.client.clone(),
            journal: self.journal.clone(),
            attachments_root: self.attachments_root.to_path_buf(),
        };
        crate::submit(
            self.index,
            gateway,
            Submission {
                thread: held.thread_id,
                session: held.session_id.clone(),
                turn: TurnId::new(execution.run.id.clone()),
                text: execution.prompt.clone(),
                model: execution
                    .session_config
                    .get("model")
                    .cloned()
                    .unwrap_or_default(),
                attachments: Vec::new(),
                skills: Vec::new(),
                submitted_at_unix_millis: execution.submitted_at_unix_millis,
            },
        )
        .await
        .map_err(ExecutionError::Catalog)?
        .ok_or(ExecutionError::MissingReceipt)
    }

    pub async fn inspect(
        &self,
        execution: &Execution,
    ) -> Result<PromptObservation, ExecutionError<E>> {
        let Some(held) = self.existing(execution).await? else {
            return Ok(PromptObservation::Missing);
        };
        observe_prompt(self.client, &held.session_id, &execution.run.id)
            .await
            .map_err(ExecutionError::Agent)
    }

    pub async fn cancel(&self, execution: &Execution) -> Result<(), ExecutionError<E>> {
        let held = self
            .existing(execution)
            .await?
            .ok_or(ExecutionError::MissingSession)?;
        self.client
            .abort_prompt(held.session_id.clone(), execution.run.id.clone())
            .await
            .map_err(ExecutionError::Agent)
    }
}
