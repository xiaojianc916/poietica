use std::collections::BTreeSet;

use poietica_problem::{Code, Retryability};

#[test]
fn every_code_has_a_distinct_message_key() {
    let mut keys = BTreeSet::new();

    for code in Code::ALL {
        assert!(
            keys.insert(code.message_key()),
            "duplicate message key for {code:?}"
        );
    }

    assert_eq!(keys.len(), Code::ALL.len());
}

#[test]
fn cancellation_is_never_retryable() {
    assert_eq!(Code::Cancelled.retryability(), Retryability::No);
}
