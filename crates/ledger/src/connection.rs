use std::fs::create_dir_all;
use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

use crate::error::LedgerError;

const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const WRITER_FLAGS: OpenFlags = OpenFlags::SQLITE_OPEN_READ_WRITE
    .union(OpenFlags::SQLITE_OPEN_CREATE)
    .union(OpenFlags::SQLITE_OPEN_NO_MUTEX);
const READER_FLAGS: OpenFlags =
    OpenFlags::SQLITE_OPEN_READ_ONLY.union(OpenFlags::SQLITE_OPEN_NO_MUTEX);

pub fn open(path: &Path) -> Result<Connection, LedgerError> {
    if let Some(parent) = path.parent() {
        create_dir_all(parent)?;
    }

    let connection = Connection::open_with_flags(path, WRITER_FLAGS)?;
    let journal_mode: String =
        connection.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;

    if !journal_mode.eq_ignore_ascii_case("wal") {
        return Err(LedgerError::JournalMode {
            actual: journal_mode,
        });
    }

    tune_writer(&connection)?;
    Ok(connection)
}

pub fn open_read_only(path: &Path) -> Result<Connection, LedgerError> {
    let connection = Connection::open_with_flags(path, READER_FLAGS)?;
    let journal_mode: String = connection.query_row("PRAGMA journal_mode", [], |row| row.get(0))?;

    if !journal_mode.eq_ignore_ascii_case("wal") {
        return Err(LedgerError::JournalMode {
            actual: journal_mode,
        });
    }

    connection.pragma_update(None, "query_only", true)?;
    connection.busy_timeout(BUSY_TIMEOUT)?;
    Ok(connection)
}

pub fn open_in_memory() -> Result<Connection, LedgerError> {
    let connection = Connection::open_in_memory()?;
    tune_writer(&connection)?;
    Ok(connection)
}

fn tune_writer(connection: &Connection) -> Result<(), LedgerError> {
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    connection.pragma_update(None, "foreign_keys", true)?;
    connection.busy_timeout(BUSY_TIMEOUT)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        reason = "a failed SQLite fixture must fail the test"
    )]

    use std::fs::remove_file;

    use uuid::Uuid;

    use super::{open, open_read_only};

    #[test]
    fn wal_reader_keeps_its_snapshot_without_blocking_the_writer() {
        let path = std::env::temp_dir().join(format!("poietica-wal-{}.sqlite3", Uuid::now_v7()));
        let writer = open(&path).expect("writer");
        writer
            .execute_batch("CREATE TABLE sample(value INTEGER); INSERT INTO sample VALUES (1);")
            .expect("schema");
        let reader = open_read_only(&path).expect("reader");

        reader.execute_batch("BEGIN").expect("read transaction");
        let before = reader
            .query_row("SELECT count(*) FROM sample", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("first snapshot");
        writer
            .execute("INSERT INTO sample VALUES (2)", [])
            .expect("writer is not blocked by the reader");
        let during = reader
            .query_row("SELECT count(*) FROM sample", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("stable snapshot");
        reader.execute_batch("ROLLBACK").expect("close snapshot");
        let after = reader
            .query_row("SELECT count(*) FROM sample", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("fresh snapshot");

        assert_eq!((before, during, after), (1, 1, 2));
        drop(reader);
        drop(writer);
        for suffix in ["", "-wal", "-shm"] {
            let _removed = remove_file(format!("{}{suffix}", path.display()));
        }
    }
}
