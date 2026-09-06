#![allow(
    clippy::expect_used,
    reason = "lifecycle fixtures must fail on unexpected errors"
)]
use crate::{
    DeliveryError, Runtime, RuntimeError, Takeover,
    journal::{FrameJournal, JournalError},
};
use poietica_ledger::execution::{IndexError, LocalIndex};
use poietica_time::wall_clock::SystemWallClock;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;

#[derive(Debug, thiserror::Error)]
enum Failure {
    #[error(transparent)]
    Index(#[from] IndexError),
    #[error(transparent)]
    Delivery(#[from] DeliveryError),
    #[error(transparent)]
    Journal(#[from] JournalError),
    #[error(transparent)]
    Runtime(#[from] RuntimeError),
}
#[tokio::test]
async fn disconnect_invalidates_an_in_progress_preparation() {
    let directory = tempfile::tempdir().expect("directory");
    let index =
        LocalIndex::<Failure>::open(&directory.path().join("index.sqlite3"), SystemWallClock)
            .expect("index");
    let journal = FrameJournal::new(index.clone(), |_, _| {}).expect("journal");
    let entered = Arc::new(tokio::sync::Notify::new());
    let preparing = Arc::clone(&entered);
    let runtime = Arc::new(Runtime::new(
        directory.path().to_path_buf(),
        directory.path().join("attachments"),
        index,
        journal,
        move |_| {
            let entered = Arc::clone(&preparing);
            Box::pin(async move {
                entered.notify_one();
                std::future::pending::<Result<poietica_kap_client::AgentSpawn, Failure>>().await
            })
        },
        |_| {},
    ));
    let starting = Arc::clone(&runtime);
    let operation = tokio::spawn(async move {
        starting
            .ensure("agent".to_owned(), None, Takeover::Replace)
            .await
    });
    entered.notified().await;
    runtime.disconnect().await.expect("disconnect");
    let outcome = tokio::time::timeout(Duration::from_secs(2), operation)
        .await
        .expect("cancelled promptly")
        .expect("task");
    assert!(matches!(outcome, Err(Failure::Runtime(RuntimeError::Gone))));
    assert!(runtime.current().expect("current").is_none());
    runtime.shutdown().expect("shutdown");
}
#[tokio::test]
async fn shutdown_is_idempotent_and_rejects_new_launches() {
    let directory = tempfile::tempdir().expect("directory");
    let index =
        LocalIndex::<Failure>::open(&directory.path().join("index.sqlite3"), SystemWallClock)
            .expect("index");
    let journal = FrameJournal::new(index.clone(), |_, _| {}).expect("journal");
    let calls = Arc::new(AtomicUsize::new(0));
    let called = Arc::clone(&calls);
    let runtime = Runtime::new(
        directory.path().to_path_buf(),
        directory.path().join("attachments"),
        index,
        journal,
        move |_| {
            called.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Err(Failure::Runtime(RuntimeError::Gone)) })
        },
        |_| {},
    );
    runtime.shutdown().expect("first shutdown");
    runtime.shutdown().expect("second shutdown");
    assert!(
        runtime
            .ensure("agent".to_owned(), None, Takeover::Replace)
            .await
            .is_err()
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn invalid_or_closed_commands_do_not_start_an_agent() {
    use crate::{CommandError, Prompt};
    use poietica_conversation::identity::TurnId;
    use poietica_ledger::index::ThreadAttachment;
    let directory = tempfile::tempdir().expect("directory");
    let index =
        LocalIndex::<Failure>::open(&directory.path().join("commands.sqlite3"), SystemWallClock)
            .expect("index");
    let journal = FrameJournal::new(index.clone(), |_, _| {}).expect("journal");
    let calls = Arc::new(AtomicUsize::new(0));
    let called = Arc::clone(&calls);
    let runtime = Runtime::new(
        directory.path().to_path_buf(),
        directory.path().join("attachments"),
        index,
        journal,
        move |_| {
            called.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Err(Failure::Runtime(RuntimeError::Gone)) })
        },
        |_| {},
    );
    let prompt = |text: &str| Prompt {
        agent_id: "agent".to_owned(),
        cwd: None,
        takeover: Takeover::Preserve,
        thread_id: uuid::Uuid::from_u128(1),
        turn: TurnId::new("submission".to_owned()),
        text: text.to_owned(),
        configuration: Vec::new(),
        assets: Vec::<ThreadAttachment>::new(),
        skills: Vec::new(),
    };
    let result = runtime
        .prompt(
            prompt("   "),
            |_thread, assets| std::future::ready(Ok::<_, Failure>(assets)),
            |_| Ok(()),
            || 1,
        )
        .await;
    assert!(matches!(result, Err(CommandError::EmptyPrompt)));
    assert!(matches!(
        runtime
            .select_configuration(None, "model".to_owned(), "model".to_owned(), None)
            .await,
        Err(CommandError::MissingSession)
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    runtime.shutdown().expect("shutdown");
    let result = runtime
        .prompt(
            prompt("work"),
            |_thread, assets| std::future::ready(Ok::<_, Failure>(assets)),
            |_| Ok(()),
            || 1,
        )
        .await;
    assert!(matches!(
        result,
        Err(CommandError::Runtime(Failure::Runtime(RuntimeError::Gone)))
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn missing_execution_identity_never_starts_an_agent() -> Result<(), Box<dyn std::error::Error>>
{
    use crate::{CommandError, PromptObservation, SessionAction, SessionError};
    let directory = tempfile::tempdir()?;
    let index =
        LocalIndex::<Failure>::open(&directory.path().join("identity.db"), SystemWallClock)?;
    let journal = FrameJournal::new(index.clone(), |_, _| {})?;
    let calls = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&calls);
    let runtime = Runtime::new(
        directory.path().to_path_buf(),
        directory.path().join("attachments"),
        index,
        journal,
        move |_| {
            counted.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Err(Failure::Runtime(RuntimeError::Gone)) })
        },
        |_| {},
    );
    let named = uuid::Uuid::new_v4().to_string();
    assert!(matches!(
        runtime.control_thread(&named, SessionAction::Cancel).await,
        Err(CommandError::MissingSession)
    ));
    assert_eq!(
        runtime
            .inspect_prompt("agent".to_owned(), None, &named, "prompt")
            .await?,
        PromptObservation::Missing
    );
    assert!(matches!(
        runtime
            .abort_owned_prompt("agent".to_owned(), None, &named, "prompt".to_owned())
            .await,
        Err(CommandError::Session(SessionError::Unbound))
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    runtime.shutdown()?;
    Ok(())
}
