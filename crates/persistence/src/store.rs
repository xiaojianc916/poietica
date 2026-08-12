//! The store itself.
//!
//! Opening the file is all this module does. What can be asked of it lives
//! next to the thing being asked about: threads.rs, attachments.rs,
//! turn_spans.rs, workbench.rs and disposals.rs each extend this same type
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
    /// `Connection::execute` 内部每次都重新 prepare，也就是把同一段 SQL 重新
    /// parse 一遍、重新 plan 一遍。省下的是微秒 —— 这些写都由人的动作触发，
    /// 不在任何热路径上。真正的收益是只剩一条写路径：下一个人照着抄的时候，
    /// 抄到的是对的那一种。
    ///
    /// 它此前住在 threads.rs 里。那里是它的第一个用户，不是它的家：Rust 的
    /// 私有性按模块算，所以第二个模块要用它只有「再抄一份」这一条路 —— 而
    /// 同一个类型上两个同名固有方法根本编译不过。一条写路径这句话，得由它
    /// 住在这个类型自己的模块里来保证，不能靠下一个人自觉。
    ///
    /// # Errors
    ///
    /// 语句被拒时返回错误。
    pub(crate) fn write(&self, sql: &str, params: &[&dyn ToSql]) -> Result<()> {
        self.connection.prepare_cached(sql)?.execute(params)?;

        Ok(())
    }
}
