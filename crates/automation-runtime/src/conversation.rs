//! Frozen automation input uses the conversation session lease and the ordinary admission pipeline.
use poietica_automation::{AutomationError, Execution};
use poietica_conversation::identity::TurnId;
use poietica_conversation_runtime::{
    DeliveryError, Submission,
    gateway::KapGateway,
    journal::FrameJournal,
    session::{Held, SessionError, SessionResolver},
};
use poietica_kap_client::{
    AgentClient, ConfigSelection, KapError, PromptObservation, SessionBook, apply_configurations,
    observe_prompt,
};
use poietica_ledger::execution::{IndexError, LocalIndex, read_index};
use std::{error::Error, path::Path};

#[derive(Debug, thiserror::Error)]
pub enum ExecutionError<E: Error + 'static> {
    #[error("automation connection preparation failed: {0}")]
    Runtime(#[source] E),
    #[error("automation delivery failed: {0}")]
    Delivery(#[source] E),
    #[error("automation conversation persistence failed: {0}")]
    Persistence(#[source] E),
    #[error(transparent)]
    Session(SessionError<E>),
    #[error(transparent)]
    Agent(KapError),
    #[error(transparent)]
    Policy(AutomationError),
    #[error("automation submission returned no receipt identity")]
    MissingReceipt,
    #[error("no official session exists for this stop request")]
    MissingSession,
}

#[derive(Debug)]
struct ConversationExecution<'a, E> {
    index: &'a LocalIndex<E>,
    client: &'a AgentClient,
    book: &'a SessionBook,
    owner: &'a str,
    sessions: &'a SessionResolver,
    journal: &'a FrameJournal,
    attachments_root: &'a Path,
}

impl<E> ConversationExecution<'_, E>
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
        .map_err(ExecutionError::Persistence)?
        .ok_or(ExecutionError::Session(SessionError::Missing))?;
        match (stored.session_id, stored.agent_id) {
            (None, None) => Ok(None),
            (Some(_), Some(owner)) if owner == execution.agent_id => {
                self.resolve(execution).await.map(Some)
            }
            _ => Err(ExecutionError::Session(SessionError::WrongOwner)),
        }
    }

    async fn submit(&self, execution: &Execution) -> Result<String, ExecutionError<E>> {
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
        let gateway = KapGateway {
            client: self.client.clone(),
            journal: self.journal.clone(),
            attachments_root: self.attachments_root.to_path_buf(),
        };
        poietica_conversation_runtime::submit(
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
            move |store| {
                let owned = store.automation_execution(&run)?;
                if owned.is_none_or(|owned| owned.cancel_requested) {
                    return Err(AutomationError::Data("取消先于提交生效".to_owned()).into());
                }
                Ok(())
            },
        )
        .await
        .map_err(ExecutionError::Delivery)?
        .ok_or(ExecutionError::MissingReceipt)
    }

    async fn inspect(&self, execution: &Execution) -> Result<PromptObservation, ExecutionError<E>> {
        let Some(held) = self.existing(execution).await? else {
            return Ok(PromptObservation::Missing);
        };
        observe_prompt(self.client, &held.session_id, &execution.run.id)
            .await
            .map_err(ExecutionError::Agent)
    }

    async fn cancel(&self, execution: &Execution) -> Result<(), ExecutionError<E>> {
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

use crate::{Executor, Observation};
use poietica_conversation_runtime::connection::{Handle, Runtime, RuntimeFailure, Takeover};
use std::sync::Arc;

pub struct ConversationExecutor<E: RuntimeFailure, F> {
    runtime: Arc<Runtime<E>>,
    index: LocalIndex<E>,
    default_agent: F,
}
impl<E: RuntimeFailure, F> std::fmt::Debug for ConversationExecutor<E, F> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ConversationExecutor")
            .finish_non_exhaustive()
    }
}
impl<E: RuntimeFailure, F> ConversationExecutor<E, F> {
    pub fn new(runtime: Arc<Runtime<E>>, index: LocalIndex<E>, default_agent: F) -> Self {
        Self {
            runtime,
            index,
            default_agent,
        }
    }
    async fn connection(&self, execution: &Execution) -> Result<Handle, ExecutionError<E>> {
        self.runtime
            .ensure(
                execution.agent_id.clone(),
                Some(execution.workspace_root.clone()),
                Takeover::Preserve,
            )
            .await
            .map_err(ExecutionError::Runtime)
    }
    fn context<'a>(&'a self, live: &'a Handle) -> ConversationExecution<'a, E> {
        ConversationExecution {
            index: &self.index,
            client: &live.client,
            book: &live.book,
            owner: &live.agent_id,
            sessions: self.runtime.sessions(),
            journal: self.runtime.journal(),
            attachments_root: self.runtime.attachments(),
        }
    }
}
impl<E, F> Executor for ConversationExecutor<E, F>
where
    E: RuntimeFailure,
    F: Fn() -> Result<String, E> + Send + Sync + 'static,
{
    type Failure = ExecutionError<E>;
    fn default_agent(&self) -> Result<String, Self::Failure> {
        (self.default_agent)().map_err(ExecutionError::Runtime)
    }
    async fn submit(&self, execution: &Execution) -> Result<String, Self::Failure> {
        let live = self.connection(execution).await?;
        self.context(&live).submit(execution).await
    }
    async fn inspect(&self, execution: &Execution) -> Result<Observation, Self::Failure> {
        let live = self.connection(execution).await?;
        Ok(match self.context(&live).inspect(execution).await? {
            PromptObservation::Active => Observation::Active,
            PromptObservation::Succeeded => Observation::Succeeded,
            PromptObservation::Failed => Observation::Failed,
            PromptObservation::Cancelled => Observation::Cancelled,
            PromptObservation::Missing => Observation::Missing,
        })
    }
    async fn cancel(&self, execution: &Execution) -> Result<(), Self::Failure> {
        let live = self.connection(execution).await?;
        self.context(&live).cancel(execution).await
    }
}
