#![allow(
    clippy::expect_used,
    reason = "submission fixtures must fail on unexpected errors"
)]
use poietica_conversation::error::GatewayFailure;
use poietica_conversation::identity::TurnId;
use poietica_conversation::ports::{
    AgentGateway, DeliveryConfirmation, DeliveryReceipt, PromptDelivery,
};
use poietica_conversation::turn::SkillSpec;
use poietica_conversation_runtime::{DeliveryError, Submission, submit};
use poietica_ledger::execution::{IndexError, LocalIndex, write_index};
use poietica_time::wall_clock::SystemWallClock;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
enum Failure {
    #[error(transparent)]
    Index(#[from] IndexError),
    #[error(transparent)]
    Delivery(#[from] DeliveryError),
}
#[derive(Clone)]
struct NonReplayable(Arc<AtomicUsize>);
impl AgentGateway for NonReplayable {
    fn can_replay(&self, _: &PromptDelivery) -> bool {
        false
    }
    fn deliver(&self, _: &PromptDelivery) -> Result<DeliveryReceipt, GatewayFailure> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(DeliveryReceipt::new(async {
            DeliveryConfirmation::Accepted {
                prompt_id: "official-receipt".to_owned(),
            }
        }))
    }
}
fn request(thread: Uuid) -> Submission {
    Submission {
        thread,
        session: "session".to_owned(),
        turn: TurnId::new("submission".to_owned()),
        text: "hello".to_owned(),
        model: String::new(),
        attachments: Vec::new(),
        skills: vec![SkillSpec {
            name: "review".to_owned(),
            args: None,
        }],
        submitted_at_unix_millis: 1,
    }
}
#[tokio::test]
async fn atomic_admission_does_not_misclassify_the_first_skill_delivery_as_replay() {
    let directory = tempfile::tempdir().expect("directory");
    let index =
        LocalIndex::<Failure>::open(&directory.path().join("index.sqlite3"), SystemWallClock)
            .expect("index");
    let thread = Uuid::new_v4();
    write_index(&index, move |store| {
        store
            .create_thread(thread, "新建对话", None)
            .map(|_| ())
            .map_err(IndexError::from)
            .map_err(Failure::from)
    })
    .await
    .expect("thread");
    let calls = Arc::new(AtomicUsize::new(0));
    let gateway = NonReplayable(Arc::clone(&calls));
    assert_eq!(
        submit(&index, gateway.clone(), request(thread), |_| Ok(()))
            .await
            .expect("first"),
        Some("official-receipt".to_owned())
    );
    assert_eq!(
        submit(&index, gateway, request(thread), |_| Ok(()))
            .await
            .expect("settled"),
        None
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_rejected_admission_policy_cannot_reach_transport() {
    let directory = tempfile::tempdir().expect("directory");
    let index =
        LocalIndex::<Failure>::open(&directory.path().join("index.sqlite3"), SystemWallClock)
            .expect("index");
    let thread = Uuid::new_v4();
    write_index(&index, move |store| {
        store
            .create_thread(thread, "新建对话", None)
            .map(|_| ())
            .map_err(IndexError::from)
            .map_err(Failure::from)
    })
    .await
    .expect("thread");
    let calls = Arc::new(AtomicUsize::new(0));
    let gateway = NonReplayable(Arc::clone(&calls));
    let outcome = submit(&index, gateway, request(thread), |_| {
        Err(poietica_ledger::LedgerError::InvalidSubmission(
            "cancelled".to_owned(),
        ))
    })
    .await;
    assert!(outcome.is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let stored = write_index(&index, move |store| {
        store
            .thread(thread)
            .map_err(IndexError::from)
            .map_err(Failure::from)
    })
    .await
    .expect("read")
    .expect("exists");
    assert_eq!(stored.title, "新建对话");
}
