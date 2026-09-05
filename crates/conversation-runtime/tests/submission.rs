use poietica_conversation::error::GatewayFailure;
use poietica_conversation::identity::TurnId;
use poietica_conversation::ports::{
    AgentGateway, ConversationLedger, DeliveryConfirmation, DeliveryReceipt, PromptDelivery,
};
use poietica_conversation_runtime::{DeliveryError, Submission, submit};
use poietica_ledger::execution::{IndexError, LocalIndex, read_index, write_index};
use poietica_ledger::index::ThreadAttachment;
use poietica_time::wall_clock::SystemWallClock;
use std::error::Error;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use uuid::Uuid;

type TestResult = Result<(), Box<dyn Error>>;

#[derive(Clone)]
struct Probe {
    calls: Arc<AtomicUsize>,
    prompt_id: String,
}
impl AgentGateway for Probe {
    fn can_replay(&self, _delivery: &PromptDelivery) -> bool {
        true
    }
    fn deliver(&self, _delivery: &PromptDelivery) -> Result<DeliveryReceipt, GatewayFailure> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let prompt_id = self.prompt_id.clone();
        Ok(DeliveryReceipt::new(async move {
            DeliveryConfirmation::Accepted { prompt_id }
        }))
    }
}
fn request(thread: Uuid, text: &str) -> Submission {
    Submission {
        thread,
        session: "session".to_owned(),
        turn: TurnId::new(Uuid::new_v4().to_string()),
        text: text.to_owned(),
        model: "model".to_owned(),
        attachments: Vec::new(),
        skills: Vec::new(),
        submitted_at_unix_millis: 1,
    }
}
fn probe() -> Probe {
    Probe {
        calls: Arc::new(AtomicUsize::new(0)),
        prompt_id: "official-prompt".to_owned(),
    }
}

#[tokio::test]
async fn submission_names_the_thread_and_links_its_attachments() -> TestResult {
    let directory = tempfile::tempdir()?;
    let index =
        LocalIndex::<DeliveryError>::open(&directory.path().join("ledger.db"), SystemWallClock)?;
    let id = Uuid::new_v4();
    write_index(&index, move |store| {
        store
            .create_thread(id, "conversation", None)
            .map_err(IndexError::from)
            .map_err(DeliveryError::from)
    })
    .await?;
    let gateway = probe();
    let mut submission = request(id, "hello");
    submission.attachments.push(ThreadAttachment {
        hash: "a".repeat(64),
        mime: "image/png".to_owned(),
        name: "image.png".to_owned(),
        byte_size: 1,
    });
    assert_eq!(
        submit(&index, gateway.clone(), submission, |_| Ok(()))
            .await?
            .as_deref(),
        Some("official-prompt")
    );
    assert_eq!(gateway.calls.load(Ordering::SeqCst), 1);
    let (title, attachments) = read_index(&index, move |store| {
        let title = store
            .thread(id)
            .map_err(IndexError::from)
            .map_err(DeliveryError::from)?
            .map(|row| row.title);
        let attachments = store
            .attachments_of(id)
            .map_err(IndexError::from)
            .map_err(DeliveryError::from)?;
        Ok((title, attachments))
    })
    .await?;
    assert_eq!(title.as_deref(), Some("hello"));
    assert_eq!(attachments.len(), 1);
    Ok(())
}

#[tokio::test]
async fn submission_preserves_a_user_title() -> TestResult {
    let directory = tempfile::tempdir()?;
    let index =
        LocalIndex::<DeliveryError>::open(&directory.path().join("ledger.db"), SystemWallClock)?;
    let id = Uuid::new_v4();
    write_index(&index, move |store| {
        store
            .create_thread(id, "conversation", None)
            .map_err(IndexError::from)
            .map_err(DeliveryError::from)?;
        store
            .name_by_user(id, "my title")
            .map_err(IndexError::from)
            .map_err(DeliveryError::from)
    })
    .await?;
    submit(&index, probe(), request(id, "another message"), |_| Ok(())).await?;
    let row = read_index(&index, move |store| {
        store
            .thread(id)
            .map_err(IndexError::from)
            .map_err(DeliveryError::from)
    })
    .await?;
    assert_eq!(row.map(|row| row.title).as_deref(), Some("my title"));
    Ok(())
}

#[tokio::test]
async fn missing_thread_fails_before_transport() -> TestResult {
    let directory = tempfile::tempdir()?;
    let index =
        LocalIndex::<DeliveryError>::open(&directory.path().join("ledger.db"), SystemWallClock)?;
    let gateway = probe();
    assert!(
        submit(
            &index,
            gateway.clone(),
            request(Uuid::new_v4(), "hello"),
            |_| Ok(())
        )
        .await
        .is_err()
    );
    assert_eq!(gateway.calls.load(Ordering::SeqCst), 0);
    Ok(())
}

#[tokio::test]
async fn an_empty_acknowledgement_does_not_discharge_the_outbox() -> TestResult {
    let directory = tempfile::tempdir()?;
    let index =
        LocalIndex::<DeliveryError>::open(&directory.path().join("ledger.db"), SystemWallClock)?;
    let id = Uuid::new_v4();
    write_index(&index, move |store| {
        store
            .create_thread(id, "conversation", None)
            .map_err(IndexError::from)
            .map_err(DeliveryError::from)
    })
    .await?;
    let submission = request(id, "hello");
    let turn = submission.turn.clone();
    let gateway = Probe {
        prompt_id: String::new(),
        ..probe()
    };
    assert!(matches!(
        submit(&index, gateway, submission, |_| Ok(())).await,
        Err(DeliveryError::Indeterminate(_))
    ));
    let state = read_index(&index, move |store| {
        store.delivery_state(&turn).map_err(DeliveryError::from)
    })
    .await?;
    assert!(state.is_some_and(|state| !state.is_settled()));
    Ok(())
}
