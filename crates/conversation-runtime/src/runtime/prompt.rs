use super::failure::CommandError;
use super::{Runtime, RuntimeFailure, Takeover};
use crate::{
    gateway::KapGateway,
    session::{SessionMode, SessionRequest},
    submission::{Submission, submit},
};
use poietica_conversation::{identity::TurnId, turn::SkillSpec};
use poietica_kap_client::{ConfigSelection, apply_configurations};
use poietica_ledger::{LedgerError, index::ThreadAttachment};
use std::{fmt, future::Future};
use uuid::Uuid;

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
            .sessions
            .resolve(
                &self.index,
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
            attachments_root: self.attachments.clone(),
        };
        // The lease spans configuration, durable admission and acknowledgement.
        let prompt_id = submit(
            &self.index,
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
}
