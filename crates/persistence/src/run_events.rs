//! 这台机器记下的帧。一条对话的时间线由它重放。

use serde_json::value::RawValue;
use uuid::Uuid;

use crate::error::Result;
use crate::store::AgentStore;

/// 日志里的一帧，按它记下时的线上形状。
#[derive(Debug)]
pub struct RecordedFrame {
    /// 帧属于哪条会话。
    pub session_id: String,
    /// 它在那条会话上的位置。
    pub seq: i64,
    /// 记下它的时刻，epoch 毫秒。
    pub at: i64,
    /// `RecordedEvent` 成形好的那一段 JSON：这一列存它，屏幕上也是它。
    pub frame: Box<RawValue>,
}

impl AgentStore {
    /// 追加一批帧，一次提交。答的是这一批里有几帧库里已经有了。
    ///
    /// 一帧一次 execute 就是一帧一个事务：autocommit 会为每一条语句写一次 WAL
    /// 提交记录、抢放一次写锁。一批帧是同一拍到达的同一件事，所以它们共用一次
    /// 提交，语句也只 prepare 一次。
    ///
    /// 同一个位置只收一次。撞上的那一帧被库挡掉，笔数报出来 —— 它的意思是这条
    /// 会话的序号线接错了（recorder.rs 的 SeqLine::resume），而咽下去的话，要到
    /// 下一次打开这条对话才看得出少了帧。一帧撞车不牵连同一批的其余帧。
    ///
    /// # Errors
    ///
    /// 语句被拒时返回错误。
    pub fn record_frames(&mut self, thread: Uuid, frames: &[RecordedFrame]) -> Result<usize> {
        let thread = thread.to_string();
        let batch = self.connection.transaction()?;
        let mut refused = 0_usize;

        {
            let mut statement = batch.prepare_cached(
                "INSERT INTO run_events (thread_id, session_id, seq, at, frame)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (thread_id, session_id, seq) DO NOTHING",
            )?;

            for frame in frames {
                let written = statement.execute(rusqlite::params![
                    thread,
                    frame.session_id,
                    frame.seq,
                    frame.at,
                    frame.frame.get()
                ])?;

                if written == 0 {
                    refused = refused.saturating_add(1);
                }
            }
        }

        batch.commit()?;

        Ok(refused)
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

    /// 这条对话上，这条会话已经用掉的最后一个位置；没有就是 0。
    ///
    /// 序号线活在内存里（agent-runtime 的 SeqLine），而这张表活过重启。会话
    /// 装载回来时号不变、槽是新的，接不上就会撞上下面那道唯一键。
    ///
    /// # Errors
    ///
    /// 查询被拒时返回错误。
    pub fn last_seq(&self, thread: Uuid, session: &str) -> Result<i64> {
        let mut statement = self.connection.prepare_cached(
            "SELECT coalesce(max(seq), 0) FROM run_events
             WHERE thread_id = ?1 AND session_id = ?2",
        )?;

        Ok(
            statement.query_row(rusqlite::params![thread.to_string(), session], |row| {
                row.get(0)
            })?,
        )
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
