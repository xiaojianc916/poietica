//! The ledger owns conversation metadata; commands validate and mutate on its writer lane.
use crate::TITLE_CHARS;
use poietica_ledger::{
    execution::{IndexError, LocalIndex, read_index, write_index},
    index::{SessionUsage, ThreadSummary},
};
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum CatalogError {
    #[error("invalid conversation identifier")]
    InvalidId,
    #[error("the conversation name is empty")]
    EmptyTitle,
    #[error("that conversation no longer exists")]
    Missing,
}

pub enum ThreadChange {
    Rename(String),
    Archive(bool),
    Pin(bool),
}
impl std::fmt::Debug for ThreadChange {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Rename(_) => "ThreadChange::Rename",
            Self::Archive(_) => "ThreadChange::Archive",
            Self::Pin(_) => "ThreadChange::Pin",
        })
    }
}

pub fn checked_title(value: &str) -> Result<String, CatalogError> {
    let title: String = value.trim().chars().take(TITLE_CHARS).collect();
    if title.is_empty() {
        return Err(CatalogError::EmptyTitle);
    }
    Ok(title)
}

pub async fn snapshot<E>(
    index: &LocalIndex<E>,
    named: &str,
) -> Result<(ThreadSummary, Option<SessionUsage>), E>
where
    E: From<IndexError> + From<CatalogError> + Send + 'static,
{
    let id = Uuid::parse_str(named).map_err(|_| E::from(CatalogError::InvalidId))?;
    read_index(index, move |store| {
        let thread = store.thread(id).map_err(IndexError::from).map_err(E::from)?
            .ok_or_else(|| E::from(CatalogError::Missing))?;
        let usage = match thread.session_id.as_deref() {
            Some(session) => store.session_usage(session)
                .map_err(IndexError::from).map_err(E::from)?,
            None => None,
        };
        Ok((thread, usage))
    }).await
}

pub async fn change<E>(index: &LocalIndex<E>, named: &str, change: ThreadChange) -> Result<(), E>
where
    E: From<IndexError> + From<CatalogError> + Send + 'static,
{
    let id = Uuid::parse_str(named).map_err(|_| E::from(CatalogError::InvalidId))?;
    write_index(index, move |store| {
        if store.thread(id).map_err(IndexError::from).map_err(E::from)?.is_none() {
            return Err(E::from(CatalogError::Missing));
        }
        match change {
            ThreadChange::Rename(raw) => {
                let title = checked_title(&raw).map_err(E::from)?;
                store.name_by_user(id, &title)
            }
            ThreadChange::Archive(archived) => store.set_archived(id, archived),
            ThreadChange::Pin(pinned) => store.set_pinned(id, pinned),
        }.map_err(IndexError::from).map_err(E::from)
    }).await
}
