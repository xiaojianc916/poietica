//! The store itself: opening the file is all this module does. Domain questions
//! live next to their domain — each module extends this same type.

use std::path::Path;

use rusqlite::{Connection, ToSql, Transaction};
use time::format_description::well_known::Rfc3339;

use poietica_time::WallClock;

use crate::error::Result;

/// Owns one database connection. The writable instance goes to one writer actor
/// and reads use a separate query-only instance, so ordering has a single owner
/// without cancelling WAL reader/writer concurrency.
#[derive(Debug)]
pub struct AgentStore {
    pub(crate) connection: Connection,
    clock: Box<dyn WallClock>,
}

impl AgentStore {
    /// Opens the store. `crate::connection::open` 写全名而非 import：本类型的
    /// 方法也叫 open，写全了读的人不用做消歧。
    pub fn open(path: &Path, clock: impl WallClock + 'static) -> Result<Self> {
        let mut connection = crate::connection::open(path)?;

        crate::migrations::apply(&mut connection, &clock)?;

        Ok(Self {
            connection,
            clock: Box::new(clock),
        })
    }

    /// 打开独立的只读连接。迁移只归 writer；query_only 由连接层强制。
    pub fn open_read_only(path: &Path, clock: impl WallClock + 'static) -> Result<Self> {
        Ok(Self {
            connection: crate::connection::open_read_only(path)?,
            clock: Box::new(clock),
        })
    }

    /// 民用时间戳，全部经过注入的时钟：测试里时间才可复现。
    pub(crate) fn now(&self) -> Result<String> {
        Ok(self.clock.now_utc().format(&Rfc3339)?)
    }

    pub(crate) fn clock(&self) -> &dyn WallClock {
        self.clock.as_ref()
    }

    /// 一段写事务：同一拍的多条写共用一次提交，调用方负责 commit。用 unchecked
    /// 是因为可写连接只归 writer actor，调用在其上串行执行。
    pub(crate) fn unchecked_transaction(&self) -> Result<Transaction<'_>> {
        Ok(self.connection.unchecked_transaction()?)
    }

    /// 一条写语句，走和读一样的语句缓存。单条写走这里；同一拍的一批写自己开
    /// 事务（journal 的批量追加）。
    pub(crate) fn write(&self, sql: &str, params: &[&dyn ToSql]) -> Result<()> {
        self.connection.prepare_cached(sql)?.execute(params)?;

        Ok(())
    }
}
