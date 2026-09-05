use super::dto::AgentLaunch;
use super::failure::translate;
use super::runtime::{AgentRuntime, Handle, borrow, ensure_session};
use crate::error::{Error, Result};
use crate::ledger::{LocalIndex, conversation};
use poietica_automation::{AutomationError, Execution};
use poietica_automation_runtime::{Executor, Observation};
use poietica_conversation::identity::TurnId;
use poietica_conversation_runtime::{Submission, gateway::KapGateway, session::Held, submit};
use poietica_kap_client::{
    ConfigSelection, PromptObservation, apply_configurations, observe_prompt,
};
use poietica_ledger::execution::read_index;
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
        if let Some(live) = borrow(&state)?
            && live.agent_id != execution.agent_id
        {
            return Err(Error::Automation(AutomationError::Data(
                "另一代理连接正在使用；自动化不会为恢复任务中断它".to_owned(),
            )));
        }
        ensure_session(
            &self.app,
            &state,
            AgentLaunch {
                agent_id: execution.agent_id.clone(),
            },
            Some(execution.workspace_root.clone()),
        )
        .await
    }

    async fn existing(&self, execution: &Execution) -> Result<Option<(Handle, Held)>> {
        let named = execution.thread_id()?;
        let thread = conversation(named)?;
        let index = self.app.state::<LocalIndex>();
        let stored = read_index(&index, move |store| {
            store.thread(thread).map_err(Error::from)
        })
        .await?
        .ok_or(AutomationError::Missing)?;
        let Some((_session, owner)) = stored.session_id.zip(stored.agent_id) else {
            return Ok(None);
        };
        if owner != execution.agent_id {
            return Err(AutomationError::Data("execution session owner changed".to_owned()).into());
        }
        let live = self.connection(execution).await?;
        let state = self.app.state::<AgentRuntime>();
        let held = state
            .sessions
            .resolve(
                &index,
                &live.client,
                &live.book,
                &live.agent_id,
                &state.root,
                named,
            )
            .await
            .map_err(Error::from)?;
        Ok(Some((live, held)))
    }
}

impl Executor for AutomationExecutor {
    type Failure = Error;
    fn default_agent(&self) -> Result<String> {
        crate::agent::profile::default_agent_id(&self.app)
    }

    async fn submit(&self, execution: &Execution) -> Result<String> {
        let live = self.connection(execution).await?;
        let state = self.app.state::<AgentRuntime>();
        let index = self.app.state::<LocalIndex>();
        let held = state
            .sessions
            .resolve(
                &index,
                &live.client,
                &live.book,
                &live.agent_id,
                &state.root,
                execution.thread_id()?,
            )
            .await
            .map_err(Error::from)?;
        let configuration: Vec<ConfigSelection> = execution
            .session_config
            .iter()
            .map(|(id, value)| ConfigSelection {
                id: id.clone(),
                value: value.clone(),
            })
            .collect();
        if !configuration.is_empty() {
            apply_configurations(
                &live.client,
                held.session_id.clone(),
                configuration,
                Some(execution.prompt.clone()),
            )
            .await
            .map_err(translate)?;
        }
        let gateway = KapGateway {
            client: live.client,
            journal: state.journal.clone(),
            attachments_root: state.attachments.clone(),
        };
        let receipt = submit(
            &index,
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
        .await?;
        receipt.ok_or_else(|| {
            Error::Internal("automation submission returned no receipt identity".to_owned())
        })
    }

    async fn inspect(&self, execution: &Execution) -> Result<Observation> {
        let Some((live, held)) = self.existing(execution).await? else {
            return Ok(Observation::Missing);
        };
        let observed = observe_prompt(&live.client, &held.session_id, &execution.run.id)
            .await
            .map_err(translate)?;
        Ok(match observed {
            PromptObservation::Active => Observation::Active,
            PromptObservation::Succeeded => Observation::Succeeded,
            PromptObservation::Failed => Observation::Failed,
            PromptObservation::Cancelled => Observation::Cancelled,
            PromptObservation::Missing => Observation::Missing,
        })
    }

    async fn cancel(&self, execution: &Execution) -> Result<()> {
        let Some((live, held)) = self.existing(execution).await? else {
            return Err(AutomationError::Data(
                "no official session exists for this stop request".to_owned(),
            )
            .into());
        };
        live.client
            .abort_prompt(held.session_id.clone(), execution.run.id.clone())
            .await
            .map_err(translate)
    }
}
