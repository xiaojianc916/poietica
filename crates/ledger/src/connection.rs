use std::fs::create_dir_all;
use std::path::Path;
use std::time::Duration;

use rusqlite::Connection;

use crate::error::LedgerError;

/// 写锁等待上限：超过它就报错，不无限阻塞在锁上。
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

pub fn open(path: &Path) -> Result<Connection, LedgerError> {
    if let Some(parent) = path.parent() {
        create_dir_all(parent)?;
    }

    let connection = Connection::open(path)?;

    // WAL 是持久设置，但在只读介质上会静默留在旧模式，所以取返回值确认。
    let journal_mode: String =
        connection.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;

    if !journal_mode.eq_ignore_ascii_case("wal") {
        return Err(LedgerError::JournalMode {
            actual: journal_mode,
        });
    }

    tune(&connection)?;

    Ok(connection)
}

/// 测试用内存账本。内存库的 journal_mode 永远是 memory，所以不查 WAL。
pub fn open_in_memory() -> Result<Connection, LedgerError> {
    let connection = Connection::open_in_memory()?;

    tune(&connection)?;

    Ok(connection)
}

fn tune(connection: &Connection) -> Result<(), LedgerError> {
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    connection.pragma_update(None, "foreign_keys", true)?;
    connection.busy_timeout(BUSY_TIMEOUT)?;

    Ok(())
}
