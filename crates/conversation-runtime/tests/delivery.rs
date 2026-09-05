use poietica_conversation::error::GatewayFailure;
use poietica_conversation::identity::{ThreadId, TurnId};
use poietica_conversation::ports::{
    AgentGateway, ConversationLedger, DeliveryConfirmation, DeliveryReceipt, PromptDelivery,
};
use poietica_conversation::turn::{Admission, DeliveryState};
use poietica_conversation_runtime::{DeliveryError, deliver};
use poietica_ledger::execution::{LocalIndex, read_index, write_index};
use poietica_time::wall_clock::SystemWallClock;
use std::error::Error;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::Duration;
use uuid::Uuid;

type TestResult = Result<(), Box<dyn Error>>;

fn request() -> PromptDelivery {
    PromptDelivery {
        admission: Admission {
            thread: ThreadId::new(Uuid::new_v4().to_string()),
            turn: TurnId::new(Uuid::new_v4().to_string()),
            prompt: "hello".to_owned(),
            model: "test".to_owned(),
            attachments: Vec::new(),
            skills: Vec::new(),
            submitted_at_unix_millis: 0,
        },
        session: "session".to_owned(),
    }
}

#[derive(Clone, Debug)]
struct Probe {
    calls: Arc<AtomicUsize>,
    confirmation: DeliveryConfirmation,
    replay: bool,
}
impl AgentGateway for Probe {
    fn can_replay(&self, _delivery: &PromptDelivery) -> bool {
        self.replay
    }
    fn deliver(&self, _delivery: &PromptDelivery) -> Result<DeliveryReceipt, GatewayFailure> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let confirmation = self.confirmation.clone();
        Ok(DeliveryReceipt::new(async move { confirmation }))
    }
}

#[tokio::test]
async fn acknowledges_the_server_identity_and_skips_a_settled_admission() -> TestResult {
    let directory = tempfile::tempdir()?;
    let index =
        LocalIndex::<DeliveryError>::open(&directory.path().join("ledger.db"), SystemWallClock)?;
    let calls = Arc::new(AtomicUsize::new(0));
    let gateway = Probe {
        calls: Arc::clone(&calls),
        confirmation: DeliveryConfirmation::Accepted {
            prompt_id: "server-owned-id".to_owned(),
        },
        replay: true,
    };
    let delivery = request();
    assert_eq!(
        deliver(&index, gateway.clone(), delivery.clone()).await?,
        Some("server-owned-id".to_owned())
    );
    assert_eq!(deliver(&index, gateway, delivery).await?, None);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    Ok(())
}

#[tokio::test]
async fn an_unknown_non_idempotent_delivery_remains_unresolved_without_replay() -> TestResult {
    let directory = tempfile::tempdir()?;
    let index =
        LocalIndex::<DeliveryError>::open(&directory.path().join("ledger.db"), SystemWallClock)?;
    let calls = Arc::new(AtomicUsize::new(0));
    let gateway = Probe {
        calls: Arc::clone(&calls),
        confirmation: DeliveryConfirmation::Indeterminate {
            reason: "response lost".to_owned(),
        },
        replay: false,
    };
    let delivery = request();
    let turn = delivery.admission.turn.clone();
    assert!(matches!(
        deliver(&index, gateway.clone(), delivery.clone()).await,
        Err(DeliveryError::Indeterminate(_))
    ));
    assert!(matches!(
        deliver(&index, gateway, delivery).await,
        Err(DeliveryError::UnsafeReplay(_))
    ));
    let state = read_index(&index, move |store| {
        store.delivery_state(&turn).map_err(DeliveryError::from)
    })
    .await?;
    assert_eq!(state, Some(DeliveryState::Unknown));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    Ok(())
}

#[derive(Debug)]
struct MaterializationGate {
    entered: mpsc::Sender<()>,
    released: mpsc::Receiver<()>,
}
impl AgentGateway for MaterializationGate {
    fn can_replay(&self, _delivery: &PromptDelivery) -> bool {
        true
    }
    fn deliver(&self, _delivery: &PromptDelivery) -> Result<DeliveryReceipt, GatewayFailure> {
        self.entered.send(()).map_err(|error| GatewayFailure {
            reason: error.to_string(),
        })?;
        self.released.recv().map_err(|error| GatewayFailure {
            reason: error.to_string(),
        })?;
        Ok(DeliveryReceipt::new(async {
            DeliveryConfirmation::Accepted {
                prompt_id: "accepted".to_owned(),
            }
        }))
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn materialization_does_not_occupy_the_database_writer() -> TestResult {
    let directory = tempfile::tempdir()?;
    let index =
        LocalIndex::<DeliveryError>::open(&directory.path().join("ledger.db"), SystemWallClock)?;
    let (entered, observed) = mpsc::channel();
    let (release, released) = mpsc::channel();
    let gateway = MaterializationGate { entered, released };
    let owned = index.clone();
    let task = tokio::spawn(async move { deliver(&owned, gateway, request()).await });
    tokio::task::spawn_blocking(move || observed.recv()).await??;
    let written =
        tokio::time::timeout(Duration::from_secs(5), write_index(&index, |_store| Ok(()))).await;
    release.send(())?;
    written??;
    assert_eq!(task.await??, Some("accepted".to_owned()));
    Ok(())
}
