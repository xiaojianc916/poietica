//! 这台机器记下的帧。一条对话的时间线由它重放。

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::Result;
use crate::store::AgentStore;

/// 日志里的一帧，按它记下时的线上形状。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RecordedFrame {
    /// 帧属于哪条会话。
    pub session_id: String,
    /// 它在那条会话上的位置。
    pub seq: i64,
    /// 记下它的时刻，epoch 毫秒。
    pub at: i64,
    /// `RecordedEvent` 的 JSON 原文。
    pub frame: String,
}

impl AgentStore {
    /// 追加一帧。同一条会话的同一个位置只收一次。
    ///
    /// # Errors
    ///
    /// 语句被拒时返回错误。
    pub fn record_frame(&self, thread: Uuid, frame: &RecordedFrame) -> Result<()> {
        self.write(
            "INSERT INTO run_events (thread_id, session_id, seq, at, frame)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (session_id, seq) DO NOTHING",
            rusqlite::params![
                thread.to_string(),
                frame.session_id,
                frame.seq,
                frame.at,
                frame.frame
            ],
        )
    }

    /// 这条对话记下的每一帧，按追加顺序。顺序由 SQL 给。
    ///
    /// # Errors
    ///
    /// 查询被拒时返回错误。
    pub fn frames_of(&self, thread: Uuid) -> Result<Vec<String>> {
        let mut statement = self
            .connection
            .prepare_cached("SELECT frame FROM run_events WHERE thread_id = ?1 ORDER BY id")?;

        let found = statement
            .query_map(rusqlite::params![thread.to_string()], |row| row.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(found)
    }

    /// 忘掉这条对话的日志。删对话时调用。
    ///
    /// # Errors
    ///
    /// 删除被拒时返回错误。
    pub(crate) fn release_run_events(&self, thread: Uuid) -> Result<()> {
        self.write(
            "DELETE FROM run_events WHERE thread_id = ?1",
            rusqlite::params![thread.to_string()],
        )
    }
}
