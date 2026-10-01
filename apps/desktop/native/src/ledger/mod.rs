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

use std::sync::{Arc, OnceLock};

/// 账本是单写者的：一个进程只开一次。开库归启动，读归命令，两边都从这里取。
static INDEX: OnceLock<Arc<LocalIndex>> = OnceLock::new();

pub(crate) fn open_index(index: Arc<LocalIndex>) -> Result<()> {
    INDEX
        .set(index)
        .map_err(|_| Error::Internal("the ledger was already opened".to_owned()))
}

pub(crate) fn index() -> Result<Arc<LocalIndex>> {
    INDEX
        .get()
        .cloned()
        .ok_or_else(|| Error::Internal("the ledger is not open".to_owned()))
}
