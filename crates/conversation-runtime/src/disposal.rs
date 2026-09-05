//! An archive intent is discharged only after a confirmed successful operation.

use std::future::Future;

use poietica_kap_client::KapError;
use poietica_ledger::execution::{IndexError, LocalIndex, write_index};

#[derive(Debug)]
pub struct DisposalFailure {
    pub session_id: String,
    pub cause: KapError,
}

pub async fn discharge<E, F, A, L>(
    index: &LocalIndex<E>,
    owner: &str,
    serving: &str,
    archive: F,
    alive: L,
) -> Result<Vec<DisposalFailure>, E>
where
    E: From<IndexError> + Send + 'static,
    F: Fn(String) -> A,
    A: Future<Output = Result<(), KapError>>,
    L: Fn() -> bool,
{
    let agent = owner.to_owned();
    let anchor = serving.to_owned();
    let pending = write_index(index, move |store| {
        store
            .record_session_disposal(&anchor, &agent)
            .map_err(IndexError::from)
            .map_err(E::from)?;
        store
            .session_disposals(&agent)
            .map_err(IndexError::from)
            .map_err(E::from)
    })
    .await?;
    let mut failures = Vec::new();
    for session_id in pending {
        if !alive() {
            break;
        }
        if session_id == serving {
            continue;
        }
        if let Err(cause) = archive(session_id.clone()).await {
            failures.push(DisposalFailure { session_id, cause });
            continue;
        }
        write_index(index, move |store| {
            store
                .discharge_session_disposal(&session_id)
                .map_err(IndexError::from)
                .map_err(E::from)
        })
        .await?;
    }
    Ok(failures)
}

#[cfg(test)]
mod tests {
    use super::discharge;
    use poietica_kap_client::KapError;
    use poietica_ledger::execution::{IndexError, LocalIndex, read_index, write_index};
    use poietica_time::wall_clock::SystemWallClock;
    use std::error::Error;
    use std::future::ready;

    #[tokio::test]
    async fn an_unconfirmed_archive_remains_due() -> Result<(), Box<dyn Error>> {
        let directory = tempfile::tempdir()?;
        let index =
            LocalIndex::<IndexError>::open(&directory.path().join("ledger.db"), SystemWallClock)?;
        write_index(&index, |store| {
            store
                .record_session_disposal("retired", "agent")
                .map_err(IndexError::from)
        })
        .await?;
        let failures = discharge(
            &index,
            "agent",
            "active",
            |_| {
                ready(Err(KapError::Transport {
                    message: "response lost".to_owned(),
                }))
            },
            || true,
        )
        .await?;
        assert_eq!(failures.len(), 1);
        let pending = read_index(&index, |store| {
            store.session_disposals("agent").map_err(IndexError::from)
        })
        .await?;
        assert!(pending.iter().any(|session| session == "retired"));
        let failures = discharge(&index, "agent", "active", |_| ready(Ok(())), || true).await?;
        assert!(failures.is_empty());
        let pending = read_index(&index, |store| {
            store.session_disposals("agent").map_err(IndexError::from)
        })
        .await?;
        assert_eq!(pending, vec!["active".to_owned()]);
        Ok(())
    }
}
