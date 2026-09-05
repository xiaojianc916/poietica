//! Host argument decoding and ledger IPC commands.
pub mod usage;
pub mod workbench;

pub type LocalIndex = poietica_ledger::execution::LocalIndex<Error>;

use crate::error::{Error, Result};
use uuid::Uuid;

pub(crate) fn counted(value: i64) -> Result<u32> {
    u32::try_from(value)
        .map_err(|_| Error::Internal("a stored count does not fit the wire".to_owned()))
}

pub(crate) fn conversation(named: &str) -> Result<Uuid> {
    Uuid::parse_str(named)
        .map_err(|_| Error::Validation("the conversation identifier is not a UUID".to_owned()))
}
