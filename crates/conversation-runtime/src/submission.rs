use crate::{DeliveryError, delivery::dispatch, gateway::attachment_reference};
use poietica_conversation::identity::{ThreadId, TurnId};
use poietica_conversation::ports::{AgentGateway, PromptDelivery};
use poietica_conversation::turn::{Admission, SkillSpec};
use poietica_ledger::execution::{IndexError, LocalIndex, write_index};
use poietica_ledger::index::ThreadAttachment;
use uuid::Uuid;

pub const TITLE_CHARS: usize = 60;

#[derive(Debug)]
pub struct Submission {
    pub thread: Uuid,
    pub session: String,
    pub turn: TurnId,
    pub text: String,
    pub model: String,
    pub attachments: Vec<ThreadAttachment>,
    pub skills: Vec<SkillSpec>,
    pub submitted_at_unix_millis: i64,
}

pub async fn submit<G, E, F>(
    index: &LocalIndex<E>,
    gateway: G,
    request: Submission,
    validate: F,
) -> Result<Option<String>, E>
where
    G: AgentGateway + Send + 'static,
    E: From<IndexError> + From<DeliveryError> + Send + 'static,
    F: FnOnce(&poietica_ledger::index::AgentStore) -> Result<(), poietica_ledger::LedgerError>
        + Send
        + 'static,
{
    let opener = if request.text.is_empty() {
        "[图片]".to_owned()
    } else {
        request.text.chars().take(TITLE_CHARS).collect()
    };
    let delivery = PromptDelivery {
        admission: Admission {
            thread: ThreadId::new(request.thread.to_string()),
            turn: request.turn,
            prompt: request.text,
            model: request.model,
            attachments: request
                .attachments
                .iter()
                .map(attachment_reference)
                .collect(),
            skills: request.skills,
            submitted_at_unix_millis: request.submitted_at_unix_millis,
        },
        session: request.session,
    };
    let requested = delivery.clone();
    let attached = request.attachments;
    let (decision, state) = write_index(index, move |store| {
        store
            .admit_submission(&requested, &opener, &attached, validate)
            .map_err(IndexError::from)
            .map_err(E::from)
    })
    .await?;
    dispatch(index, gateway, delivery, decision, state).await
}
