use poietica_conversation_runtime::catalog::{CatalogError, ThreadChange, change, checked_title, snapshot};
use poietica_ledger::execution::{IndexError, LocalIndex, write_index};
use poietica_time::wall_clock::SystemWallClock;
use std::error::Error;
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
enum Failure {
    #[error(transparent)]
    Index(#[from] IndexError),
    #[error(transparent)]
    Catalog(#[from] CatalogError),
}

#[tokio::test]
async fn catalog_edits_share_the_persisted_identity() -> Result<(), Box<dyn Error>> {
    let directory = tempfile::tempdir()?;
    let index = LocalIndex::<Failure>::open(&directory.path().join("ledger.db"), SystemWallClock)?;
    let id = Uuid::new_v4();
    write_index(&index, move |store| {
        store.create_thread(id, "conversation", None)
            .map_err(IndexError::from).map_err(Failure::from)
    }).await?;
    let named = id.to_string();
    change(&index, &named, ThreadChange::Rename("  chosen title  ".to_owned())).await?;
    change(&index, &named, ThreadChange::Archive(true)).await?;
    change(&index, &named, ThreadChange::Pin(true)).await?;
    let (thread, usage) = snapshot(&index, &named).await?;
    assert_eq!(thread.id, id.to_string());
    assert_eq!(thread.title, "chosen title");
    assert!(thread.archived_at.is_some());
    assert!(thread.pinned);
    assert!(usage.is_none());
    change(&index, &named, ThreadChange::Archive(false)).await?;
    assert!(snapshot(&index, &named).await?.0.archived_at.is_none());
    Ok(())
}

#[tokio::test]
async fn missing_conversations_cannot_accept_any_catalog_edit() -> Result<(), Box<dyn Error>> {
    let directory = tempfile::tempdir()?;
    let index = LocalIndex::<Failure>::open(&directory.path().join("ledger.db"), SystemWallClock)?;
    let named = Uuid::new_v4().to_string();
    for operation in [
        ThreadChange::Rename("title".to_owned()),
        ThreadChange::Archive(true),
        ThreadChange::Pin(true),
    ] {
        assert!(matches!(change(&index, &named, operation).await,
            Err(Failure::Catalog(CatalogError::Missing))));
    }
    assert!(matches!(snapshot(&index, &named).await,
        Err(Failure::Catalog(CatalogError::Missing))));
    assert!(matches!(snapshot(&index, "not-an-identity").await,
        Err(Failure::Catalog(CatalogError::InvalidId))));
    Ok(())
}

#[test]
fn title_policy_is_shared_by_edits_and_forks() -> Result<(), Box<dyn Error>> {
    assert!(matches!(checked_title(" \n\t "), Err(CatalogError::EmptyTitle)));
    assert_eq!(checked_title("  title  ")?, "title");
    let long = "界".repeat(poietica_conversation_runtime::TITLE_CHARS + 1);
    assert_eq!(checked_title(&long)?.chars().count(), poietica_conversation_runtime::TITLE_CHARS);
    Ok(())
}
