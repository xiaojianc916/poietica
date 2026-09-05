use super::{
    dto::AgentLaunch,
    failure::translate,
    runtime::{AgentRuntime, Handle, ensure_automation_session},
};
use crate::{
    error::{Error, Result},
    ledger::LocalIndex,
};
use poietica_automation::{AutomationError, Execution};
use poietica_automation_runtime::{Executor, Observation};
use poietica_conversation_runtime::automation::{Context, ExecutionError};
use poietica_kap_client::PromptObservation;
use tauri::{AppHandle, Manager};

pub(crate) struct AutomationExecutor {
    app: AppHandle,
}
impl AutomationExecutor {
    pub(crate) fn new(app: AppHandle) -> Self {
        Self { app }
    }

    async fn connection(&self, execution: &Execution) -> Result<Handle> {
        let state = self.app.state::<AgentRuntime>();
        ensure_automation_session(
            &self.app,
            &state,
            AgentLaunch {
                agent_id: execution.agent_id.clone(),
            },
            Some(execution.workspace_root.clone()),
        )
        .await
    }
}

fn context<'a>(
    index: &'a LocalIndex,
    runtime: &'a AgentRuntime,
    live: &'a Handle,
) -> Context<'a, Error> {
    Context {
        index,
        client: &live.client,
        book: &live.book,
        owner: &live.agent_id,
        sessions: &runtime.sessions,
        journal: &runtime.journal,
        attachments_root: &runtime.attachments,
    }
}

fn failure(error: ExecutionError<Error>) -> Error {
    match error {
        ExecutionError::Catalog(error) => error,
        ExecutionError::Session(error) => Error::from(error),
        ExecutionError::Agent(error) => translate(error),
        ExecutionError::Policy(error) => Error::Automation(error),
        ExecutionError::Cancelled => {
            Error::Automation(AutomationError::Data("取消先于提交生效".to_owned()))
        }
        ExecutionError::MissingReceipt => {
            Error::Internal("automation submission returned no receipt identity".to_owned())
        }
        ExecutionError::MissingSession => Error::Automation(AutomationError::Data(
            "no official session exists for this stop request".to_owned(),
        )),
    }
}

impl Executor for AutomationExecutor {
    type Failure = Error;
    fn default_agent(&self) -> Result<String> {
        crate::agent::profile::default_agent_id(&self.app)
    }

    async fn submit(&self, execution: &Execution) -> Result<String> {
        let live = self.connection(execution).await?;
        let runtime = self.app.state::<AgentRuntime>();
        let index = self.app.state::<LocalIndex>();
        context(&index, &runtime, &live)
            .submit(execution)
            .await
            .map_err(failure)
    }

    async fn inspect(&self, execution: &Execution) -> Result<Observation> {
        let live = self.connection(execution).await?;
        let runtime = self.app.state::<AgentRuntime>();
        let index = self.app.state::<LocalIndex>();
        let observed = context(&index, &runtime, &live)
            .inspect(execution)
            .await
            .map_err(failure)?;
        Ok(match observed {
            PromptObservation::Active => Observation::Active,
            PromptObservation::Succeeded => Observation::Succeeded,
            PromptObservation::Failed => Observation::Failed,
            PromptObservation::Cancelled => Observation::Cancelled,
            PromptObservation::Missing => Observation::Missing,
        })
    }

    async fn cancel(&self, execution: &Execution) -> Result<()> {
        let live = self.connection(execution).await?;
        let runtime = self.app.state::<AgentRuntime>();
        let index = self.app.state::<LocalIndex>();
        context(&index, &runtime, &live)
            .cancel(execution)
            .await
            .map_err(failure)
    }
}
