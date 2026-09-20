//! 上一次关掉时，工作台开着哪几格。

use rusqlite::OptionalExtension as _;

use crate::error::Result;
use crate::index::store::AgentStore;

impl AgentStore {
    pub fn workbench_session(&self) -> Result<Option<String>> {
        let mut statement = self
            .connection
            .prepare_cached("SELECT document FROM workbench_session WHERE slot = 0")?;

        let found = statement
            .query_row([], |row| row.get::<_, String>(0))
            .optional()?;

        Ok(found)
    }

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
