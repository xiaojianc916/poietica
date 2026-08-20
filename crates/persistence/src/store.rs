//! The store itself.
//!
//! Opening the file is all this module does. What can be asked of it lives
//! next to the thing being asked about: threads.rs, attachments.rs,
//! run_events.rs, workbench.rs and disposals.rs each extend this same type
//! with the questions of their own domain.

use std::path::Path;

use rusqlite::{Connection, ToSql};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::error::Result;
use crate::migrations::migrate;

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
    /// 一个入口。此前是两个：一个去钥匙串取密钥，另一个收调用者给的一把 ——
    /// 后者存在的唯一理由，是让测试不必碰真的钥匙串。库不再加密，那个理由
    /// 随之消失，两个入口塌回一个。
    ///
    /// 调用的是 `crate::connection::open` 的全名而不是 import 进来：这个类型
    /// 自己的方法也叫 open，写全了就没有人需要在脑子里做一次消歧。
    ///
    /// # Errors
    ///
    /// Fails when the file cannot be opened or a migration is rejected.
    pub fn open(path: &Path) -> Result<Self> {
        let mut connection = crate::connection::open(path)?;
        migrate(&mut connection)?;
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
