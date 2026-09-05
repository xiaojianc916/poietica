//! Submission metadata and durable admission share one application use case.
use poietica_conversation::identity::{ThreadId, TurnId};
use poietica_conversation::ports::{AgentGateway, PromptDelivery};
use poietica_conversation::turn::{Admission, SkillSpec};
use poietica_ledger::execution::{IndexError, LocalIndex, write_index};
use poietica_ledger::index::ThreadAttachment;
use uuid::Uuid;

use crate::DeliveryError;
use crate::gateway::attachment_reference;

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

/// Attachment bytes must be prepared before entering the submission use case.
pub async fn submit<G, E>(
    index: &LocalIndex<E>,
    gateway: G,
    request: Submission,
) -> Result<Option<String>, E>
where
    G: AgentGateway + Send + 'static,
    E: From<IndexError> + From<DeliveryError> + Send + 'static,
{
    let Submission {
        thread,
        session,
        turn,
        text,
        model,
        attachments,
        skills,
        submitted_at_unix_millis,
    } = request;
    let opener: String = if text.is_empty() {
        "[图片]".to_owned()
    } else {
        text.chars().take(TITLE_CHARS).collect()
    };
    let references = attachments.iter().map(attachment_reference).collect();
    // Writer serialization does not make these separate store operations one SQL transaction.
    write_index(index, move |store| {
        store
            .record_prompt(thread, &opener)
            .map_err(IndexError::from)
            .map_err(E::from)?;
        for attachment in &attachments {
            store
                .remember_attachment(thread, attachment)
                .map_err(IndexError::from)
                .map_err(E::from)?;
        }
        Ok(())
    })
    .await?;
    crate::deliver(
        index,
        gateway,
        PromptDelivery {
            admission: Admission {
                thread: ThreadId::new(thread.to_string()),
                turn,
                prompt: text,
                model,
                attachments: references,
                skills,
                submitted_at_unix_millis,
            },
            session,
        },
    )
    .await
}
