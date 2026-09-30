use crate::{DeliveryError, delivery::dispatch, gateway::attachment_reference};
use poietica_conversation::identity::{ThreadId, TurnId};
use poietica_conversation::ports::{AgentGateway, PromptDelivery};
use poietica_conversation::turn::{Admission, DeliverAs, SkillSpec};
use poietica_ledger::execution::{IndexError, LocalIndex, write_index};
use poietica_ledger::index::ThreadAttachment;
use uuid::Uuid;

pub const TITLE_CHARS: usize = 60;

#[derive(Debug)]
pub(crate) struct Submission {
    pub(crate) thread: Uuid,
    pub(crate) session: String,
    pub(crate) turn: TurnId,
    pub(crate) text: String,
    pub(crate) model: String,
    pub(crate) attachments: Vec<ThreadAttachment>,
    pub(crate) skills: Vec<SkillSpec>,
    /// 这一句走哪一层。插话不开轮，但同样要过准入与投递这两关。
    pub(crate) deliver_as: DeliverAs,
    pub(crate) submitted_at_unix_millis: i64,
}

pub(crate) async fn submit<G, E, F>(
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
        "[附件]".to_owned()
    } else {
        request.text.chars().take(TITLE_CHARS).collect()
    };
    /*
     * 插话不给线程起名：能插话就说明这条对话已经有一轮在跑，名字早有了；而标题的
     * 正本在 threads 表（单写者），让第二句话去覆盖它只会把用户手打的名字冲掉。
     */
    let title = if request.deliver_as.is_interjection() {
        None
    } else {
        Some(opener)
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
            deliver_as: request.deliver_as,
            submitted_at_unix_millis: request.submitted_at_unix_millis,
        },
        session: request.session,
    };
    let requested = delivery.clone();
    let attached = request.attachments;
    let (decision, state) = write_index(index, move |store| {
        store
            .admit_submission(&requested, title.as_deref(), &attached, validate)
            .map_err(IndexError::from)
            .map_err(E::from)
    })
    .await?;
    dispatch(index, gateway, delivery, decision, state).await
}

#[cfg(test)]
mod admission;
#[cfg(test)]
mod behavior;
