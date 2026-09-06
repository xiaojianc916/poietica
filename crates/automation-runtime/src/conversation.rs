use crate::{Executor, Observation};
use poietica_automation::{AutomationError, Execution};
use poietica_conversation::identity::TurnId;
use poietica_conversation_runtime::{
    CommandError, ConfigSelection, Prompt, PromptObservation, Runtime, RuntimeFailure,
    SessionError, Takeover,
};
use std::{error::Error, fmt, sync::Arc};
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum ExecutionError<E: Error + 'static> {
    #[error("default agent resolution failed: {0}")]
    Runtime(#[source] E),
    #[error(transparent)]
    Command(CommandError<E>),
    #[error(transparent)]
    Policy(AutomationError),
}

pub struct ConversationExecutor<E: RuntimeFailure, F> {
    runtime: Arc<Runtime<E>>,
    default_agent: F,
}
impl<E: RuntimeFailure, F> fmt::Debug for ConversationExecutor<E, F> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ConversationExecutor")
            .finish_non_exhaustive()
    }
}
impl<E: RuntimeFailure, F> ConversationExecutor<E, F> {
    pub fn new(runtime: Arc<Runtime<E>>, default_agent: F) -> Self {
        Self {
            runtime,
            default_agent,
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
        let thread_id = Uuid::parse_str(execution.thread_id().map_err(ExecutionError::Policy)?)
            .map_err(|_| ExecutionError::Command(CommandError::Session(SessionError::InvalidId)))?;
        let run = execution.run.id.clone();
        let receipt = self
            .runtime
            .prompt(
                Prompt {
                    agent_id: execution.agent_id.clone(),
                    cwd: Some(execution.workspace_root.clone()),
                    takeover: Takeover::Preserve,
                    thread_id,
                    turn: TurnId::new(run.clone()),
                    text: execution.prompt.clone(),
                    configuration: execution
                        .session_config
                        .iter()
                        .map(|(id, value)| ConfigSelection {
                            id: id.clone(),
                            value: value.clone(),
                        })
                        .collect(),
                    assets: Vec::<poietica_ledger::index::ThreadAttachment>::new(),
                    skills: Vec::new(),
                },
                |_, assets| std::future::ready(Ok::<_, E>(assets)),
                move |store| {
                    let owned = store.automation_execution(&run)?;
                    if owned.is_none_or(|owned| owned.cancel_requested) {
                        return Err(AutomationError::Data("取消先于提交生效".to_owned()).into());
                    }
                    Ok(())
                },
                || execution.submitted_at_unix_millis,
            )
            .await
            .map_err(ExecutionError::Command)?;
        Ok(receipt.prompt_id)
    }

    async fn inspect(&self, execution: &Execution) -> Result<Observation, Self::Failure> {
        let named = execution.thread_id().map_err(ExecutionError::Policy)?;
        let observed = self
            .runtime
            .inspect_prompt(
                execution.agent_id.clone(),
                Some(execution.workspace_root.clone()),
                named,
                &execution.run.id,
            )
            .await
            .map_err(ExecutionError::Command)?;
        Ok(match observed {
            PromptObservation::Active => Observation::Active,
            PromptObservation::Succeeded => Observation::Succeeded,
            PromptObservation::Failed => Observation::Failed,
            PromptObservation::Cancelled => Observation::Cancelled,
            PromptObservation::Missing => Observation::Missing,
        })
    }

    async fn cancel(&self, execution: &Execution) -> Result<(), Self::Failure> {
        let named = execution.thread_id().map_err(ExecutionError::Policy)?;
        self.runtime
            .abort_owned_prompt(
                execution.agent_id.clone(),
                Some(execution.workspace_root.clone()),
                named,
                execution.run.id.clone(),
            )
            .await
            .map_err(ExecutionError::Command)
    }
}
