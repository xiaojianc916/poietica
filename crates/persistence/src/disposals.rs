//! 会话处置账：本地已经不认、agent 侧还留着的那些会话。
//!
//! agent 那一份不随本地行一起消失：送达一句 session/delete 要一条活着的、
//! 主人对得上的、声明过能力的连接，而删除发生的那一刻常常凑不齐三样 ——
//! 离线删除、换号、锚会话退役、幽灵行收割，全是同一件事。这张表记的就是
//! 欠下的那句话：一行一笔账，下一次对上这个 agent 的连接握手后冲销
//! （桌面 seam 的 record_and_flush_disposals）。

use crate::error::Result;
use crate::store::{AgentStore, now};

impl AgentStore {
    /// 记一笔待送达的 session/delete。
    ///
    /// 同一个号记两次是同一笔账：换号与收割可能先后碰到同一条会话，第二次
    /// 落账不该是错误。
    ///
    /// # Errors
    ///
    /// Fails when the insert is rejected.
    pub fn record_session_disposal(&self, session_id: &str, agent_id: &str) -> Result<()> {
        self.write(
            "INSERT INTO session_disposals (session_id, agent_id, noted_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT (session_id) DO NOTHING",
            rusqlite::params![session_id, agent_id, now()?],
        )?;

        Ok(())
    }

    /// 销一笔账。
    ///
    /// 送达即销；agent 答了但拒绝也销 —— 拒绝只说明它自己早就不留着这条
    /// 会话，一笔永远送不达的账不是账，是每次连接都要重付的税。
    ///
    /// # Errors
    ///
    /// Fails when the delete is rejected.
    pub fn discharge_session_disposal(&self, session_id: &str) -> Result<()> {
        self.write(
            "DELETE FROM session_disposals WHERE session_id = ?1",
            rusqlite::params![session_id],
        )?;

        Ok(())
    }

    /// 这个 agent 名下未销的账，按落账先后。
    ///
    /// # Errors
    ///
    /// Fails when the query is rejected.
    pub fn session_disposals(&self, agent_id: &str) -> Result<Vec<String>> {
        let mut statement = self.connection.prepare_cached(
            "SELECT session_id FROM session_disposals WHERE agent_id = ?1 ORDER BY noted_at",
        )?;

        let found = statement
            .query_map(rusqlite::params![agent_id], |row| row.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(found)
    }
}
