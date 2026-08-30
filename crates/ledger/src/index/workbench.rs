//! 上一次关掉时，工作台开着哪几格。
//!
//! 这一份由这个 crate 存，但不由它解释。一格标签指向的表面有哪些，唯一的
//! 注册处在渲染层（packages/workspace 的 surface-registry），这一侧连判断
//! 它对不对的依据都没有。存一份不看内容的文档，好过存一份验不动的结构 ——
//! 后者只是把「没人验」写成「看起来验过」。
//!
//! 一行。CHECK (slot = 0) 让「只有一份」成为结构性的真，而不是靠每一次写入
//! 自觉。

use rusqlite::OptionalExtension as _;

use crate::error::Result;
use crate::index::store::AgentStore;

impl AgentStore {
    /// 上一次留下的那一份。从来没有存过就是 None。
    ///
    /// # Errors
    ///
    /// 查询被拒时返回错误。
    pub fn workbench_session(&self) -> Result<Option<String>> {
        let mut statement = self
            .connection
            .prepare_cached("SELECT document FROM workbench_session WHERE slot = 0")?;

        let found = statement
            .query_row([], |row| row.get::<_, String>(0))
            .optional()?;

        Ok(found)
    }

    /// 写下这一份，盖掉上一份。
    ///
    /// UPSERT 而不是先删后插：一条语句就是一次替换，中间不存在「一份都没有」
    /// 的那一瞬。
    ///
    /// # Errors
    ///
    /// 语句被拒时返回错误。
    pub fn set_workbench_session(&self, document: &str) -> Result<()> {
        self.write(
            "INSERT INTO workbench_session (slot, document, updated_at)
             VALUES (0, ?1, ?2)
             ON CONFLICT (slot) DO UPDATE SET
               document   = excluded.document,
               updated_at = excluded.updated_at",
            rusqlite::params![document, self.now()?],
        )
    }
}
