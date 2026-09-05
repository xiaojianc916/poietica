//! 投递用例拥有准入、传输确认及恢复；数据库 actor 内不得调用网关。
use poietica_conversation::command::Conversation;
use poietica_conversation::error::{DomainFailure, LedgerUnavailable};
use poietica_conversation::ports::{
    AgentGateway, ConversationLedger, DeliveryConfirmation, PromptDelivery,
};
use poietica_conversation::turn::AdmissionDecision;
use poietica_ledger::execution::{IndexError, LocalIndex, read_index, write_index};
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum DeliveryError {
    #[error(transparent)]
    Index(#[from] IndexError),
    #[error(transparent)]
    Domain(#[from] DomainFailure),
    #[error(transparent)]
    Ledger(#[from] LedgerUnavailable),
    #[error("admitted turn has no outbox entry: {0}")]
    MissingAdmission(String),
    #[error("prompt was rejected: {0}")]
    Rejected(String),
    #[error("delivery is indeterminate: {0}")]
    Indeterminate(String),
    #[error("delivery requires reconciliation before replay: {0}")]
    UnsafeReplay(String),
    #[error("invalid thread identity in the outbox: {0}")]
    Identity(String),
}

#[derive(Debug)]
pub struct RecoveryFailure<E> {
    pub turn: String,
    pub failure: E,
}

/// None 表示此前已经结清；只有本次确认带回官方 prompt ID。
pub async fn deliver<G, E>(
    index: &LocalIndex<E>,
    gateway: G,
    delivery: PromptDelivery,
) -> Result<Option<String>, E>
where
    G: AgentGateway + Send + 'static,
    E: From<IndexError> + From<DeliveryError> + Send + 'static,
{
    let requested = delivery.clone();
    let (decision, state) = write_index(index, move |store| {
        let decision = Conversation::new(store)
            .admit(&requested)
            .map_err(|error| E::from(DeliveryError::Domain(error)))?;
        let state = store
            .delivery_state(&requested.admission.turn)
            .map_err(|error| E::from(DeliveryError::Ledger(error)))?
            .ok_or_else(|| {
                E::from(DeliveryError::MissingAdmission(
                    requested.admission.turn.as_str().to_owned(),
                ))
            })?;
        Ok((decision, state))
    })
    .await?;

    if state.is_settled() {
        return Ok(None);
    }
    if decision == AdmissionDecision::AlreadyAdmitted && !gateway.can_replay(&delivery) {
        return Err(E::from(DeliveryError::UnsafeReplay(
            delivery.admission.turn.as_str().to_owned(),
        )));
    }
    let turn = delivery.admission.turn.clone();
    // 只有真正的同步附件 I/O 放入阻塞池；异步收据不占用阻塞线程。
    let confirmation = match tokio::task::spawn_blocking(move || gateway.deliver(&delivery)).await {
        Ok(Ok(receipt)) => receipt.settle().await,
        Ok(Err(failure)) => DeliveryConfirmation::Rejected {
            reason: failure.reason,
        },
        Err(failure) => DeliveryConfirmation::Indeterminate {
            reason: failure.to_string(),
        },
    };
    let outcome = confirmation.outcome();
    write_index(index, move |store| {
        store
            .record_delivery(&turn, outcome)
            .map_err(|error| E::from(DeliveryError::Ledger(error)))
    })
    .await?;
    match confirmation {
        DeliveryConfirmation::Accepted { prompt_id } => Ok(Some(prompt_id)),
        DeliveryConfirmation::Rejected { reason } => Err(E::from(DeliveryError::Rejected(reason))),
        DeliveryConfirmation::Indeterminate { reason } => {
            Err(E::from(DeliveryError::Indeterminate(reason)))
        }
    }
}

/// 只恢复当前 agent 拥有且仍有会话地址的欠账；一笔失败不阻止其他对话。
pub async fn recover<G, E>(
    index: &LocalIndex<E>,
    gateway: G,
    agent_id: &str,
) -> Result<Vec<RecoveryFailure<E>>, E>
where
    G: AgentGateway + Clone + Send + 'static,
    E: From<IndexError> + From<DeliveryError> + Send + 'static,
{
    let admissions = read_index(index, |store| {
        store
            .unresolved_deliveries()
            .map_err(|error| E::from(DeliveryError::Ledger(error)))
    })
    .await?;
    let mut failures = Vec::new();
    for admission in admissions {
        let turn = admission.turn.as_str().to_owned();
        let thread = match Uuid::parse_str(admission.thread.as_str()) {
            Ok(thread) => thread,
            Err(error) => {
                failures.push(RecoveryFailure {
                    turn,
                    failure: E::from(DeliveryError::Identity(error.to_string())),
                });
                continue;
            }
        };
        let holder = match read_index(index, move |store| {
            store
                .thread(thread)
                .map_err(IndexError::from)
                .map_err(E::from)
        })
        .await
        {
            Ok(holder) => holder,
            Err(failure) => {
                failures.push(RecoveryFailure { turn, failure });
                continue;
            }
        };
        let session = holder
            .filter(|thread| thread.agent_id.as_deref() == Some(agent_id))
            .and_then(|thread| thread.session_id);
        let Some(session) = session else {
            continue;
        };
        if let Err(failure) = deliver(
            index,
            gateway.clone(),
            PromptDelivery { admission, session },
        )
        .await
        {
            failures.push(RecoveryFailure { turn, failure });
        }
    }
    Ok(failures)
}
