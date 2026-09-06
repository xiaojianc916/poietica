use super::{CommandError, Handle, Runtime, RuntimeFailure, Takeover};
use crate::session::{SessionError, address};
use poietica_kap_client::{ApprovalResponse, PromptObservation, QuestionResponse, observe_prompt};

#[derive(Debug)]
pub enum SessionAction {
    Cancel,
    Steer(Vec<String>),
    AbortPrompt(String),
}

impl<E: RuntimeFailure> Runtime<E> {
    pub(super) fn require_live(&self) -> Result<Handle, CommandError<E>> {
        self.connection
            .current()
            .map_err(CommandError::Runtime)?
            .ok_or(CommandError::MissingSession)
    }

    pub fn answer_permission(
        &self,
        id: &str,
        response: ApprovalResponse,
    ) -> Result<(), CommandError<E>> {
        self.require_live()?
            .desk
            .answer(id, response)
            .map_err(CommandError::Interaction)
    }

    pub fn answer_questions(
        &self,
        id: &str,
        response: QuestionResponse,
    ) -> Result<(), CommandError<E>> {
        self.require_live()?
            .questions
            .answer(id, response)
            .map_err(CommandError::Interaction)
    }

    pub fn dismiss_questions(&self, id: &str) -> Result<(), CommandError<E>> {
        self.require_live()?
            .questions
            .dismiss(id)
            .map_err(CommandError::Interaction)
    }

    pub async fn control_thread(
        &self,
        named: &str,
        action: SessionAction,
    ) -> Result<(), CommandError<E>> {
        let live = self.require_live()?;
        let session = address(&self.index, named, &live.agent_id)
            .await
            .map_err(CommandError::Session)?
            .ok_or(CommandError::Session(SessionError::Unbound))?;
        dispatch(&live, session, action)
            .await
            .map_err(CommandError::Agent)
    }

    pub async fn inspect_prompt(
        &self,
        agent: String,
        cwd: Option<String>,
        named: &str,
        prompt: &str,
    ) -> Result<PromptObservation, CommandError<E>> {
        let Some(session) = address(&self.index, named, &agent)
            .await
            .map_err(CommandError::Session)?
        else {
            return Ok(PromptObservation::Missing);
        };
        let live = self
            .ensure(agent, cwd, Takeover::Preserve)
            .await
            .map_err(CommandError::Runtime)?;
        observe_prompt(&live.client, &session, prompt)
            .await
            .map_err(CommandError::Agent)
    }

    pub async fn abort_owned_prompt(
        &self,
        agent: String,
        cwd: Option<String>,
        named: &str,
        prompt: String,
    ) -> Result<(), CommandError<E>> {
        let session = address(&self.index, named, &agent)
            .await
            .map_err(CommandError::Session)?
            .ok_or(CommandError::Session(SessionError::Unbound))?;
        let live = self
            .ensure(agent, cwd, Takeover::Preserve)
            .await
            .map_err(CommandError::Runtime)?;
        dispatch(&live, session, SessionAction::AbortPrompt(prompt))
            .await
            .map_err(CommandError::Agent)
    }
}

async fn dispatch(
    live: &Handle,
    session: String,
    action: SessionAction,
) -> Result<(), poietica_kap_client::KapError> {
    match action {
        SessionAction::Cancel => live.client.cancel(session).await,
        SessionAction::Steer(prompts) => live.client.steer(session, prompts).await,
        SessionAction::AbortPrompt(prompt) => live.client.abort_prompt(session, prompt).await,
    }
}
