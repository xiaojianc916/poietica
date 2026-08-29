//! 这台机器记下的帧。一条对话的时间线由它重放。

use rusqlite::OptionalExtension;
use serde_json::value::RawValue;
use uuid::Uuid;

use crate::error::Result;
use crate::index::store::AgentStore;

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

/// 一页帧从哪儿往前读：表上那把唯一键 `(session_id, seq)`。
#[derive(Clone, Debug)]
pub struct FrameCursor {
    /// 位置属于哪条会话。
    pub session_id: String,
    /// 它在那条会话上的位置。
    pub seq: i64,
}

/// 目录里的一轮：地址，加上预览卡看得见的那两段。
#[derive(Debug)]
pub struct TurnMark {
    /// 这一轮第一帧所在的会话。
    pub session_id: String,
    /// 它在那条会话上的位置。
    pub seq: i64,
    /// 本机签发的 durable admission identity；屏幕上那条用户消息用同一个号。
    pub admission_id: String,
    pub prompt: String,
    pub reply: Option<String>,
}

/// 一页帧，按追加顺序；`before` 缺席就是前面没有了。
#[derive(Debug)]
pub struct FramePage {
    /// 这一页的帧，各是 `RecordedEvent` 成形好的那一行 JSON。
    pub frames: Vec<Box<RawValue>>,
    /// 更早那一页从哪儿接着读。
    pub before: Option<FrameCursor>,
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

    /// 这条对话的一页完整轮次，按追加顺序交回。
    ///
    /// 游标只负责给出右边界；页宽按轮次计算。查询先用 prompt 帧定位最早边界，
    /// 再一次顺序读取整页，渲染层不需要反复往前追到轮次开头。
    ///
    /// # Errors
    ///
    /// 查询被拒，或 before 在这条对话上指不到行时返回错误。
    pub fn turns_before(
        &self,
        thread: Uuid,
        before: Option<&FrameCursor>,
        turn_start: &str,
        limit: i64,
    ) -> Result<FramePage> {
        let ceiling = match before {
            Some(cursor) => self.frame_row(thread, cursor)?,
            None => i64::MAX,
        };
        let offset = limit.max(1).saturating_sub(1);
        let thread_id = thread.to_string();

        let floor = self
            .connection
            .prepare_cached(
                "SELECT id FROM run_events
                 WHERE thread_id = ?1 AND id < ?2
                   AND json_extract(frame, '$.kind') = ?3
                 ORDER BY id DESC
                 LIMIT 1 OFFSET ?4",
            )?
            .query_row(
                rusqlite::params![thread_id, ceiling, turn_start, offset],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        self.page(&thread_id, floor, ceiling, turn_start)
    }

    /// 从这一轮的第一帧起，读到已经载入的那一帧之前为止。
    ///
    /// 目录点名的那一轮可能在窗口之外。缺口一次读回来，屏幕上因此仍然只有一段
    /// 连着尾部的经过，而不是中间挖着洞的两段。
    ///
    /// # Errors
    ///
    /// 查询被拒，或两个位置在这条对话上指不到行时返回错误。
    pub fn turns_until(
        &self,
        thread: Uuid,
        from: &FrameCursor,
        before: &FrameCursor,
        turn_start: &str,
    ) -> Result<FramePage> {
        let floor = self.frame_row(thread, from)?;
        let ceiling = self.frame_row(thread, before)?;

        self.page(&thread.to_string(), Some(floor), ceiling, turn_start)
    }

    /// 这条对话的整本目录：一轮一行，按追加顺序。
    ///
    /// 问出自开轮那一帧，答取这一轮里第一条正文 delta；两段都在库里按预览卡看得见
    /// 的字数截断 —— 目录要的是那张卡上的两行，不是整段回答。子代理的 delta 不算。
    ///
    /// 判别式由调用方交进来：这一层只认 JSON 里那一格（与 turns_before 同一条规矩）。
    ///
    /// # Errors
    ///
    /// 查询被拒时返回错误。
    pub fn turn_marks(
        &self,
        thread: Uuid,
        turn_start: &str,
        event_kind: &str,
        delta_type: &str,
        prompt_chars: i64,
        reply_chars: i64,
    ) -> Result<Vec<TurnMark>> {
        let mut statement = self.connection.prepare_cached(
            "SELECT t.session_id, t.seq,
                    coalesce(json_extract(t.frame, '$.admissionId'), ''),
                    substr(coalesce(json_extract(t.frame, '$.prompt'), ''), 1, ?5),
                    (SELECT substr(json_extract(r.frame, '$.payload.delta'), 1, ?6)
                       FROM run_events r
                      WHERE r.thread_id = ?1 AND r.id > t.id
                        AND r.id < coalesce((SELECT min(p.id) FROM run_events p
                                              WHERE p.thread_id = ?1 AND p.id > t.id
                                                AND json_extract(p.frame, '$.kind') = ?2), ?7)
                        AND json_extract(r.frame, '$.kind') = ?3
                        AND json_extract(r.frame, '$.payload.type') = ?4
                        AND coalesce(json_extract(r.frame, '$.payload.agentId'), '') = ''
                      ORDER BY r.id ASC
                      LIMIT 1)
             FROM run_events t
             WHERE t.thread_id = ?1 AND json_extract(t.frame, '$.kind') = ?2
             ORDER BY t.id ASC",
        )?;

        let marks = statement
            .query_map(
                rusqlite::params![
                    thread.to_string(),
                    turn_start,
                    event_kind,
                    delta_type,
                    prompt_chars,
                    reply_chars,
                    i64::MAX
                ],
                |row| {
                    Ok(TurnMark {
                        session_id: row.get(0)?,
                        seq: row.get(1)?,
                        admission_id: row.get(2)?,
                        prompt: row.get(3)?,
                        reply: row.get(4)?,
                    })
                },
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(marks)
    }

    /// 一页帧：[floor, ceiling) 之间的行，以及更早那一页从哪儿接着读。
    fn page(
        &self,
        thread_id: &str,
        floor: Option<i64>,
        ceiling: i64,
        turn_start: &str,
    ) -> Result<FramePage> {
        let lower = floor.unwrap_or(0);

        let mut statement = self.connection.prepare_cached(
            "SELECT session_id, seq, frame FROM run_events
             WHERE thread_id = ?1 AND id >= ?2 AND id < ?3
             ORDER BY id ASC",
        )?;
        let read = statement
            .query_map(rusqlite::params![thread_id, lower, ceiling], |row| {
                Ok((
                    FrameCursor {
                        session_id: row.get(0)?,
                        seq: row.get(1)?,
                    },
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        let has_more = match floor {
            Some(floor) => self
                .connection
                .prepare_cached(
                    "SELECT EXISTS(
                       SELECT 1 FROM run_events
                       WHERE thread_id = ?1 AND id < ?2
                         AND json_extract(frame, '$.kind') = ?3
                     )",
                )?
                .query_row(rusqlite::params![thread_id, floor, turn_start], |row| {
                    row.get::<_, bool>(0)
                })?,
            None => false,
        };
        let before = if has_more {
            read.first().map(|(cursor, _)| cursor.clone())
        } else {
            None
        };

        Ok(FramePage {
            frames: read
                .into_iter()
                .map(|(_, frame)| RawValue::from_string(frame))
                .collect::<serde_json::Result<Vec<_>>>()?,
            before,
        })
    }

    /// 游标那一行在表上的编号。内部编号不出这个 crate，翻译只在这里。
    fn frame_row(&self, thread: Uuid, cursor: &FrameCursor) -> Result<i64> {
        let mut statement = self.connection.prepare_cached(
            "SELECT id FROM run_events
             WHERE thread_id = ?1 AND session_id = ?2 AND seq = ?3",
        )?;

        Ok(statement.query_row(
            rusqlite::params![thread.to_string(), cursor.session_id, cursor.seq],
            |row| row.get(0),
        )?)
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

    /// 倒数第 drop_turns 轮起点那一行的编号；分叉复制以它为上界（不含）。
    ///
    /// drop_turns 为 0、或这条对话没有那么多轮时交回 i64::MAX —— 整条都在分叉
    /// 点之前。「哪一帧开一轮」由认识帧的那一侧回答（agent-runtime 的 frame.rs），
    /// 判别式因此由调用方交进来：这一层只认 JSON 里那一格。
    ///
    /// # Errors
    ///
    /// 查询被拒时返回错误。
    pub(crate) fn turn_cut(&self, thread: Uuid, drop_turns: u32, turn_start: &str) -> Result<i64> {
        if drop_turns == 0 {
            return Ok(i64::MAX);
        }

        let mut statement = self.connection.prepare_cached(
            "SELECT id FROM run_events
             WHERE thread_id = ?1 AND json_extract(frame, '$.kind') = ?2
             ORDER BY id DESC
             LIMIT 1 OFFSET ?3",
        )?;

        let found = statement
            .query_row(
                rusqlite::params![thread.to_string(), turn_start, drop_turns - 1],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;

        Ok(found.unwrap_or(i64::MAX))
    }

    // 对话删除的多表事务由 threads.rs 单点持有。
}
