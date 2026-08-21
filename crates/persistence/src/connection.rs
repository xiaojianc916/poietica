use std::path::Path;
use std::time::Duration;

use rusqlite::Connection;

use crate::error::Result;

/// How long a writer waits for the lock before giving up.
pub const DEFAULT_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// Opens the database and puts it into the configuration the rest of the
/// crate assumes.
///
/// # Errors
///
/// Fails when the file cannot be opened or a pragma is rejected.
pub(crate) fn open(path: &Path) -> Result<Connection> {
    let connection = Connection::open(path)?;

    // WAL keeps commits append-only; synchronous = NORMAL drops the per-commit fsync.
    //
    // 这一句交回来的是生效之后的模式，不是「有没有报错」。只读目录、网络盘、
    // 或者正被另一个进程按回滚日志开着的文件，都会让它安静地交回 delete。此前
    // 这一格被丢进 _mode，于是那种库跑的是回滚日志 —— 读会被写挡住，界面每撞
    // 一次锁就静等满 busy_timeout 那五秒，而没有任何地方说得出为什么。
    //
    // 不为此报错：那会把一个还能用、只是慢的库变成一个打不开的库。说出来就够了。
    let mode: String = connection.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;

    if !mode.eq_ignore_ascii_case("wal") {
        log::warn!(
            "the database is in {mode} journal mode instead of wal; reads will block while a write is in flight"
        );
    }

    connection.pragma_update(None, "synchronous", "NORMAL")?;
    connection.pragma_update(None, "foreign_keys", true)?;
    connection.busy_timeout(DEFAULT_BUSY_TIMEOUT)?;

    Ok(connection)
}
