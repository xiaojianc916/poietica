use super::{CommandError, Handle, Runtime, RuntimeFailure, Takeover};
use crate::session::{SessionError, address};
use poietica_agent_client::{
    ApprovalResponse, PromptObservation, QuestionResponse, QueuedState, WithdrawnMessage,
    observe_prompt,
};

#[derive(Debug)]
pub enum SessionAction {
    Cancel,
    AbortPrompt(String),
}

/// 改队列模式时交上来的那几格；缺席即不改。
///
/// 取值域由 agent 自己把关（`all | one-at-a-time` / `immediate | wait`），本层只转发 ——
/// 抄一份枚举就是第二个事实，上游加一档我们就会静默把它拒掉。
#[derive(Debug, Default, Clone)]
pub struct DeliveryModes {
    pub steering: Option<String>,
    pub follow_up: Option<String>,
    pub interrupt: Option<String>,
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

    /// 待发队列此刻的样子（两层正文 + 三个模式）。队列的真相在 agent 里。
    pub async fn queued(&self) -> Result<QueuedState, CommandError<E>> {
        self.require_live()?
            .client
            .queue()
            .await
            .map_err(CommandError::Agent)
    }

    /// 撤回最后一条还排着的插话；空队列是 `None`，不是错。
    pub async fn withdraw(&self) -> Result<Option<WithdrawnMessage>, CommandError<E>> {
        self.require_live()?
            .client
            .withdraw()
            .await
            .map_err(CommandError::Agent)
    }

    /// 改队列模式并回交改完之后那一份队列。
    pub async fn set_delivery_modes(
        &self,
        modes: DeliveryModes,
    ) -> Result<QueuedState, CommandError<E>> {
        self.require_live()?
            .client
            .set_delivery_modes(modes.steering, modes.follow_up, modes.interrupt)
            .await
            .map_err(CommandError::Agent)
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
) -> Result<(), poietica_agent_client::AgentError> {
    match action {
        SessionAction::Cancel => live.client.cancel(session).await,
        SessionAction::AbortPrompt(prompt) => live.client.abort_prompt(session, prompt).await,
    }
}
