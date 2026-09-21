#![allow(clippy::expect_used, reason = "fixture failures must fail the test")]
use super::*;
use crate::content::AssetSessionSnapshotEntry;

fn content(bytes: &[u8], mime: &str) -> AssetSessionSnapshotEntry {
    use sha2::{Digest, Sha256};
    AssetSessionSnapshotEntry::verify(
        hex::encode(Sha256::digest(bytes)),
        mime.to_owned(),
        Arc::new(bytes.to_vec()),
    )
    .expect("verified fixture")
}

#[test]
fn a_conflict_does_not_register_other_members_or_increment_existing_references() {
    let registry = AssetProtocolRegistry::default();
    registry.open_session("session").expect("session");
    let existing = content(b"existing", "text/plain");
    let fresh = content(b"fresh", "text/plain");
    registry
        .register("session", vec![existing.clone()])
        .expect("initial");
    let conflict = content(b"existing", "image/png");
    assert_eq!(
        registry.register("session", vec![fresh.clone(), existing.clone(), conflict]),
        Err(AssetProtocolError::DuplicateAsset)
    );
    assert!(matches!(
        registry.deliver("session", fresh.content_hash()),
        Err(AssetProtocolError::NotFound)
    ));
    registry
        .remove("session", existing.content_hash())
        .expect("remove");
    assert_eq!(registry.total_bytes(), 0);
}

#[test]
fn reference_overflow_does_not_partially_commit_a_batch() {
    let registry = AssetProtocolRegistry::default();
    registry.open_session("session").expect("session");
    let existing = content(b"existing", "text/plain");
    registry
        .register("session", vec![existing.clone()])
        .expect("initial");
    {
        let mut state = registry.state.write().expect("lock");
        state
            .sessions
            .get_mut("session")
            .expect("session")
            .get_mut(existing.content_hash())
            .expect("asset")
            .references = u32::MAX;
    }
    let fresh = content(b"fresh", "text/plain");
    assert_eq!(
        registry.register("session", vec![fresh.clone(), existing]),
        Err(AssetProtocolError::ReferenceOverflow)
    );
    assert!(matches!(
        registry.deliver("session", fresh.content_hash()),
        Err(AssetProtocolError::NotFound)
    ));
    assert_eq!(registry.total_bytes(), b"existing".len());
}

#[test]
fn oversized_content_is_rejected_before_registration() {
    let bytes = vec![0; crate::identity::MAX_ASSET_BYTES + 1];
    assert_eq!(
        AssetSessionSnapshotEntry::from_bytes(bytes),
        Err(AssetProtocolError::AssetTooLarge)
    );
}

/* 预算是注册表自己的判据，连已经收下的字节一起算：把这条挪回调用方就会更松。 */
#[test]
fn a_batch_that_exceeds_the_registry_budget_is_refused_and_leaves_nothing_behind() {
    let registry = AssetProtocolRegistry::default();
    registry.open_session("session").expect("session");

    /* 单份上限 32 MiB、总预算 256 MiB：拿满 8 份就正好越过总额。 */
    let full = crate::identity::MAX_ASSET_BYTES;
    let held: Vec<_> = (0..8)
        .map(|fill| content(&vec![fill; full], "application/pdf"))
        .collect();
    registry
        .register("session", held)
        .expect("eight fit exactly at the cap");

    let overflow = content(&vec![99; full], "application/pdf");
    assert_eq!(
        registry.register("session", vec![overflow.clone()]),
        Err(AssetProtocolError::RegistryBudgetExceeded)
    );
    /* 整批不进：超预算那一份不许留下一半。 */
    assert!(matches!(
        registry.deliver("session", overflow.content_hash()),
        Err(AssetProtocolError::NotFound)
    ));
}
