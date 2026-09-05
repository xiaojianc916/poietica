use crate::connection::{RuntimeError, RuntimeFailure};
use poietica_kap_client::{SessionBook, SessionEvent, SessionUsageSnapshot};
use poietica_ledger::execution::{IndexError, LocalIndex, write_index};
use poietica_ledger::index::{SessionCursor, SessionUsage};

fn stored_usage(usage: SessionUsageSnapshot) -> SessionUsage {
    fn narrow(value: u64) -> i64 {
        i64::try_from(value).unwrap_or(i64::MAX)
    }
    SessionUsage {
        used: narrow(usage.used),
        size: narrow(usage.size),
        input_other: narrow(usage.input_other),
        input_cache_read: narrow(usage.input_cache_read),
        input_cache_creation: narrow(usage.input_cache_creation),
    }
}

pub(crate) async fn record<E: RuntimeFailure>(
    index: &LocalIndex<E>,
    book: &SessionBook,
    event: &SessionEvent,
) -> Result<(), E> {
    match event {
        SessionEvent::Usage { session_id, usage } => {
            let session = session_id.clone();
            let usage = stored_usage(*usage);
            write_index(index, move |store| {
                store
                    .record_usage(&session, usage)
                    .map_err(IndexError::from)
                    .map_err(E::from)
            })
            .await
        }
        SessionEvent::Cursor { session_id, cursor } => {
            let session = session_id.clone();
            let cursor = SessionCursor {
                seq: cursor.seq,
                epoch: cursor.epoch.clone(),
            };
            write_index(index, move |store| {
                store
                    .remember_cursor(&session, &cursor)
                    .map_err(IndexError::from)
                    .map_err(E::from)
            })
            .await
        }
        SessionEvent::CursorLost { session_id } => {
            let session = session_id.clone();
            write_index(index, move |store| {
                store
                    .forget_cursor(&session)
                    .map_err(IndexError::from)
                    .map_err(E::from)
            })
            .await
        }
        SessionEvent::Link(link) => book
            .note_link(link)
            .map(|_| ())
            .map_err(RuntimeError::Agent)
            .map_err(E::from),
        SessionEvent::Selectors { .. }
        | SessionEvent::Transcript { .. }
        | SessionEvent::ModelCatalogChanged => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persistence_does_not_round_trip_through_the_ipc_integer_width() {
        let usage = stored_usage(SessionUsageSnapshot {
            used: u64::from(u32::MAX) + 1,
            size: u64::MAX,
            input_other: 3,
            input_cache_read: 4,
            input_cache_creation: 5,
        });
        assert_eq!(usage.used, i64::from(u32::MAX) + 1);
        assert_eq!(usage.size, i64::MAX);
        assert_eq!(usage.input_cache_creation, 5);
    }
}
