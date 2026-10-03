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

/*
 * 会话不在册与资产不在册必须分开：前者是调用方走错了会话（拿 A 的令牌去 B 里删），
 * 后者是通用文件的正常形态。共用一档会让跨会话的删除静默成功 —— 实测过的那个缺陷。
 */
#[test]
fn removing_from_a_session_that_does_not_exist_is_an_error_not_a_silent_success() {
    let registry = AssetProtocolRegistry::default();
    registry.open_session("a").expect("session");
    let held = content(b"held", "image/png");
    registry
        .register("a", vec![held.clone()])
        .expect("register");
    registry.open_session("b").expect("session");

    /* B 拿 A 的令牌删：必须是查无此项，而不是成功。 */
    assert!(matches!(
        registry.remove("b", held.content_hash()),
        Err(AssetProtocolError::NotFound)
    ));
    /* 资产还在 A 里 —— 这一条正是从前静默成功时被掩盖的事实。 */
    assert!(registry.deliver("a", held.content_hash()).is_ok());

    /* 谁都没有这份资产：通用文件那一档，仍是正常结果。 */
    assert_eq!(
        registry.remove("a", &"f".repeat(64)),
        Ok(Removal::NotRegistered)
    );
    /* 真的放掉那一档。 */
    assert_eq!(
        registry.remove("a", held.content_hash()),
        Ok(Removal::Released)
    );
}

/*
 * 切片算术。它的调用方是 native 的 asset_read —— 那里只该做「解参 → 调 crate → DTO」，
 * 所以边界情况必须在这里被钉住：越界、饱和、空段、整份。
 */
#[test]
fn a_read_span_covers_exactly_what_the_caller_asked_for() {
    assert_eq!(read_span(100, None, None), 0..100);
    assert_eq!(read_span(100, Some(10), Some(20)), 10..30);
    /* 开放区间：从某处到末尾。 */
    assert_eq!(read_span(100, Some(90), None), 90..100);
    /* 越界的起点收敛成空段，不是 panic 也不是从头开始。 */
    assert_eq!(read_span(100, Some(100), Some(10)), 100..100);
    assert_eq!(read_span(100, Some(999), Some(10)), 100..100);
    /* 长度越过末尾就截到末尾。 */
    assert_eq!(read_span(100, Some(90), Some(999)), 90..100);
    /* u64 上限不许溢出成 panic。 */
    assert_eq!(read_span(100, Some(u64::MAX), Some(u64::MAX)), 100..100);
    /* 空资产。 */
    assert_eq!(read_span(0, Some(0), Some(10)), 0..0);
}
