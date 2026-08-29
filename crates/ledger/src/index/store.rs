//! The store itself.
//!
//! Opening the file is all this module does. What can be asked of it lives
//! next to the thing being asked about: each domain module extends this same
//! type with the questions of its own domain.

use std::path::Path;

use rusqlite::{Connection, ToSql};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use poietica_time::WallClock;

use crate::error::Result;

/// Owns the database.
///
/// A single writer is intentional. The log is the contention point and its
/// ordering is what everything else relies on, so serialising writes here is
/// simpler and safer than reconciling interleaved sequence numbers later.
#[derive(Debug)]
pub struct AgentStore {
    pub(crate) connection: Connection,
}

pub(crate) fn now() -> Result<String> {
    Ok(OffsetDateTime::now_utc().format(&Rfc3339)?)
}

impl AgentStore {
    /// Opens the store.
    ///
    /// 调用的是 `crate::connection::open` 的全名而不是 import 进来：这个类型
    /// 自己的方法也叫 open，写全了就没有人需要在脑子里做一次消歧。
    ///
    /// # Errors
    ///
    /// Fails when the file cannot be opened or a migration is rejected.
    pub fn open(path: &Path, clock: &dyn WallClock) -> Result<Self> {
        let mut connection = crate::connection::open(path)?;

        crate::migrations::apply(&mut connection, clock)?;

        Ok(Self { connection })
    }

    /// 一条写语句，走和读一样的那个语句缓存。
    ///
    /// 人的动作触发的单条写走这里；同一拍到达的一批写自己开事务
    /// （run_events.rs 的 record_frames）。
    ///
    /// # Errors
    ///
    /// 语句被拒时返回错误。
    pub(crate) fn write(&self, sql: &str, params: &[&dyn ToSql]) -> Result<()> {
        self.connection.prepare_cached(sql)?.execute(params)?;

        Ok(())
    }
}
