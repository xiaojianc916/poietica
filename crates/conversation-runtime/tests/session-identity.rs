use poietica_ledger::execution::{IndexError, LocalIndex, read_index, write_index};
use poietica_time::wall_clock::SystemWallClock;
use std::error::Error;
use uuid::Uuid;

type TestResult = Result<(), Box<dyn Error>>;

#[tokio::test]
async fn binding_is_idempotent_but_cannot_replace_an_identity() -> TestResult {
    let directory = tempfile::tempdir()?;
    let index =
        LocalIndex::<IndexError>::open(&directory.path().join("ledger.db"), SystemWallClock)?;
    let id = Uuid::new_v4();
    write_index(&index, move |store| {
        store.create_thread(id, "test", None)?;
        store.attach_session(id, "first", "agent")?;
        store.attach_session(id, "first", "agent")?;
        Ok(())
    })
    .await?;
    let refused = write_index(&index, move |store| {
        store
            .attach_session(id, "second", "agent")
            .map_err(IndexError::from)
    })
    .await;
    assert!(refused.is_err());
    let held = read_index(&index, move |store| {
        store.thread(id).map_err(IndexError::from)
    })
    .await?;
    assert_eq!(
        held.and_then(|row| row.session_id).as_deref(),
        Some("first")
    );
    Ok(())
}

#[tokio::test]
async fn binding_a_deleted_conversation_is_an_error() -> TestResult {
    let directory = tempfile::tempdir()?;
    let index =
        LocalIndex::<IndexError>::open(&directory.path().join("ledger.db"), SystemWallClock)?;
    let id = Uuid::new_v4();
    write_index(&index, move |store| {
        store.create_thread(id, "test", None)?;
        store.delete_thread(id)?;
        Ok(())
    })
    .await?;
    let result = write_index(&index, move |store| {
        store
            .attach_session(id, "session", "agent")
            .map_err(IndexError::from)
    })
    .await;
    assert!(result.is_err());
    Ok(())
}
