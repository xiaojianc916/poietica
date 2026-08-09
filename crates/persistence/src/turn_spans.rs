//! 每一轮的两端：哪条对话的第几轮，从什么时候到什么时候。
//!
//! 这与 lib.rs 那句「对话说过什么不在这里」并不矛盾。一轮的两端不是对话
//! 内容，是这台机器上发生过的一件事的两个时刻：agent 交还的历史
//!（session/load）里没有任何原来的时刻 —— 协议里没有这一格。归属清楚，
//! 存放的地方才清楚。

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::Result;
use crate::store::AgentStore;

/// 一轮的两端，epoch 毫秒。
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TurnSpan {
    /// 这是这条对话里的第几轮，从 0 数起 —— record_prompt 发的那一号，
    /// 与附件同一把尺子（见迁移 0011）。
    pub turn: i64,
    /// 这一轮发出去的时刻。
    pub started_at: i64,
    /// 这一轮落定的时刻。答复、失败、对面没了，三种结局都算落定。
    pub ended_at: i64,
}

impl AgentStore {
    /// 记下一轮的两端。
    ///
    /// UPSERT 而不是裸 INSERT：同一号的第二次到达以新写下的两端为准。
    ///
    /// # Errors
    ///
    /// 语句被拒时返回错误。
    pub fn record_turn_span(&self, thread: Uuid, span: &TurnSpan) -> Result<()> {
        self.write(
            "INSERT INTO turn_spans (thread_id, turn, started_at, ended_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (thread_id, turn) DO UPDATE SET
               started_at = excluded.started_at,
               ended_at   = excluded.ended_at",
            rusqlite::params![
                thread.to_string(),
                span.turn,
                span.started_at,
                span.ended_at
            ],
        )
    }

    /// 这条对话记下的每一轮，按轮次顺序。
    ///
    /// 顺序由 SQL 给，不由调用方再排一遍：与 attachments_of 同一条规矩。
    ///
    /// # Errors
    ///
    /// 查询被拒时返回错误。
    pub fn turn_spans_of(&self, thread: Uuid) -> Result<Vec<TurnSpan>> {
        let mut statement = self.connection.prepare_cached(
            "SELECT turn, started_at, ended_at
               FROM turn_spans
              WHERE thread_id = ?1
              ORDER BY turn",
        )?;

        let found = statement
            .query_map(rusqlite::params![thread.to_string()], |row| {
                Ok(TurnSpan {
                    turn: row.get(0)?,
                    started_at: row.get(1)?,
                    ended_at: row.get(2)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(found)
    }

    /// 忘掉这条对话的每一轮。删对话时调用 —— 与 release_attachments 同一条
    /// 规矩：清理写在一个删除动作里，不指望默认关着的外键。
    ///
    /// # Errors
    ///
    /// 删除被拒时返回错误。
    pub(crate) fn release_turn_spans(&self, thread: Uuid) -> Result<()> {
        self.write(
            "DELETE FROM turn_spans WHERE thread_id = ?1",
            rusqlite::params![thread.to_string()],
        )
    }
}
