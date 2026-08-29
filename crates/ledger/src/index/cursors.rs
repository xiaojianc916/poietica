//! kap 的事件流，这台机器读到哪儿了。

use crate::error::Result;
use crate::index::store::{AgentStore, now};

/// 一条会话的事件流上，已经被这台机器读到的位置。
///
/// 位置由 kap 签发（信封上的 seq，跨守护进程重启有效），纪元说明它属于哪一段流。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionCursor {
    /// 信封上的 seq。
    pub seq: i64,
    /// 那一段流的纪元；server 没报就是空。
    pub epoch: Option<String>,
}

impl AgentStore {
    /// 记下这条会话读到哪儿了。
    ///
    /// 同一纪元只前进：乱序到达的一帧不该把读点拉回去。纪元一换就整格重置 ——
    /// 新纪元的 seq 与旧纪元的 seq 不在同一条流上（contracts/kap/asyncapi.json
    /// components/messages/resync_required：epoch_changed 是 reason 枚举的
    /// 三种断流原因之一）。
    ///
    /// # Errors
    ///
    /// 语句被拒时返回错误。
    pub fn remember_cursor(&self, session: &str, cursor: &SessionCursor) -> Result<()> {
        self.write(
            "INSERT INTO session_cursors (session_id, seq, epoch, at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (session_id) DO UPDATE SET
                 seq = excluded.seq, epoch = excluded.epoch, at = excluded.at
             WHERE excluded.epoch IS NOT session_cursors.epoch
                OR excluded.seq > session_cursors.seq",
            rusqlite::params![session, cursor.seq, cursor.epoch, now()?],
        )
    }

    /// 这条会话上一次读到哪儿了；没读过就是空。
    ///
    /// # Errors
    ///
    /// 查询被拒时返回错误。
    pub fn cursor_of(&self, session: &str) -> Result<Option<SessionCursor>> {
        let mut statement = self
            .connection
            .prepare_cached("SELECT seq, epoch FROM session_cursors WHERE session_id = ?1")?;

        let found = statement
            .query_map(rusqlite::params![session], |row| {
                Ok(SessionCursor {
                    seq: row.get(0)?,
                    epoch: row.get(1)?,
                })
            })?
            .next()
            .transpose()?;

        Ok(found)
    }

    /// 忘掉这条会话的读点：kap 说那一段流断了，从它接不下去。
    ///
    /// # Errors
    ///
    /// 删除被拒时返回错误。
    pub fn forget_cursor(&self, session: &str) -> Result<()> {
        self.write(
            "DELETE FROM session_cursors WHERE session_id = ?1",
            rusqlite::params![session],
        )
    }
}
