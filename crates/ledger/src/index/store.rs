//! The store itself.
//!
//! Opening the file is all this module does. What can be asked of it lives
//! next to the thing being asked about: each domain module extends this same
//! type with the questions of its own domain.

use std::path::Path;

use rusqlite::{Connection, ToSql, Transaction};
use time::format_description::well_known::Rfc3339;

use poietica_time::WallClock;

use crate::error::Result;

/// Owns one database connection.
///
/// LocalIndex gives the writable instance to one writer actor and opens a
/// separate query-only instance for reads. Ordering therefore has one owner
/// without cancelling WAL reader/writer concurrency.
#[derive(Debug)]
pub struct AgentStore {
    pub(crate) connection: Connection,
    clock: Box<dyn WallClock>,
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

    /// 一段写事务。同一拍的多条写共用一次提交；调用方负责 commit。
    ///
    /// unchecked：可写连接只归 writer actor，调用在该 actor 上串行执行。
    ///
    /// # Errors
    ///
    /// 语句被拒时返回错误。
    pub(crate) fn unchecked_transaction(&self) -> Result<Transaction<'_>> {
        Ok(self.connection.unchecked_transaction()?)
    }

    /// 一条写语句，走和读一样的那个语句缓存。
    ///
    /// 人的动作触发的单条写走这里；同一拍到达的一批写自己开事务
    /// （conversation/screen.rs 的分页读、journal 的批量追加）。
    ///
    /// # Errors
    ///
    /// 语句被拒时返回错误。
    pub(crate) fn write(&self, sql: &str, params: &[&dyn ToSql]) -> Result<()> {
        self.connection.prepare_cached(sql)?.execute(params)?;

        Ok(())
    }
}
