//! Frozen automation input uses the conversation session lease and the ordinary admission pipeline.
use poietica_automation::{AutomationError, Execution};
use poietica_conversation::identity::TurnId;
use poietica_conversation_runtime::{
    connection::{CommandError, Prompt},
    session::{Held, SessionError, SessionResolver},
};
use poietica_kap_client::{
    AgentClient, ConfigSelection, KapError, PromptObservation, SessionBook,
    observe_prompt,
};
use poietica_ledger::execution::{IndexError, LocalIndex, read_index};
use std::{error::Error, path::Path};

#[derive(Debug, thiserror::Error)]
pub enum ExecutionError<E: Error + 'static> {
    #[error("automation connection preparation failed: {0}")]
    Runtime(#[source] E),
    #[error(transparent)]
    Command(CommandError<E>),
    #[error("automation conversation persistence failed: {0}")]
    Persistence(#[source] E),
    #[error(transparent)]
    Session(SessionError<E>),
    #[error(transparent)]
    Agent(KapError),
    #[error(transparent)]
    Policy(AutomationError),
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
}

impl<E> ConversationExecution<'_, E>
where
    E: Error + From<IndexError> + Send + 'static,
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
        let thread_id = uuid::Uuid::parse_str(
            execution.thread_id().map_err(ExecutionError::Policy)?,
        ).map_err(|_| ExecutionError::Session(SessionError::InvalidId))?;
        let run = execution.run.id.clone();
        let receipt = self.runtime.prompt(
            Prompt {
                agent_id: execution.agent_id.clone(),
                cwd: Some(execution.workspace_root.clone()),
                takeover: Takeover::Preserve,
                thread_id,
                turn: TurnId::new(execution.run.id.clone()),
                text: execution.prompt.clone(),
                configuration: execution.session_config.iter().map(|(id, value)| ConfigSelection {
                    id: id.clone(), value: value.clone(),
                }).collect(),
                assets: Vec::<poietica_ledger::index::ThreadAttachment>::new(),
                skills: Vec::new(),
            },
            |_thread, attached| std::future::ready(Ok::<_, E>(attached)),
            move |store| {
                let owned = store.automation_execution(&run)?;
                if owned.is_none_or(|owned| owned.cancel_requested) {
                    return Err(AutomationError::Data("取消先于提交生效".to_owned()).into());
                }
                Ok(())
            },
            || execution.submitted_at_unix_millis,
        ).await.map_err(ExecutionError::Command)?;
        Ok(receipt.prompt_id)
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
