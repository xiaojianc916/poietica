//! 屏幕那条经过的读路：按轮分页、目录预览、分叉复制。
//!
//! 载荷就是事件联合的 JSON（kind 判别式在内），所以这里的查询只认 JSON 里
//! 那一格 —— 与写路共用同一份事实。信封格子（sessionId/seq/at）在列上，
//! 读回时并回载荷顶层，交出去的形状与旧帧账逐字节一致。

use rusqlite::OptionalExtension;
use serde_json::value::RawValue;
use uuid::Uuid;

use crate::error::Result;
use crate::index::store::AgentStore;

/// 一页帧从哪儿往前读：表上那把位置键。
#[derive(Clone, Debug)]
pub struct FrameCursor {
    /// 位置属于哪条会话。
    pub session_id: String,
    /// 它在这次对话里的位置（账本发的号）。
    pub seq: i64,
}

/// 目录里的一轮：地址，加上预览卡看得见的那两段。
#[derive(Debug)]
pub struct TurnMark {
    /// 这一轮第一帧所在的会话。
    pub session_id: String,
    /// 它在这次对话里的位置。
    pub seq: i64,
    /// 本机签发的 durable admission identity；屏幕上那条用户消息用同一个号。
    pub admission_id: String,
    pub prompt: String,
    pub reply: Option<String>,
}

/// 一页帧，按追加顺序；`before` 缺席就是前面没有了。
#[derive(Debug)]
pub struct FramePage {
    /// 这一页的帧，各是重建好的线上 JSON。
    pub frames: Vec<Box<RawValue>>,
    /// 更早那一页从哪儿接着读。
    pub before: Option<FrameCursor>,
}

impl AgentStore {
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
                "SELECT seq FROM conversation_events
                 WHERE thread_id = ?1 AND seq < ?2
                   AND json_extract(payload, '$.kind') = ?3
                 ORDER BY seq DESC
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
                    coalesce(json_extract(t.payload, '$.admissionId'), ''),
                    substr(coalesce(json_extract(t.payload, '$.prompt'), ''), 1, ?5),
                    (SELECT substr(json_extract(r.payload, '$.payload.delta'), 1, ?6)
                       FROM conversation_events r
                      WHERE r.thread_id = ?1 AND r.seq > t.seq
                        AND r.seq < coalesce((SELECT min(p.seq) FROM conversation_events p
                                              WHERE p.thread_id = ?1 AND p.seq > t.seq
                                                AND json_extract(p.payload, '$.kind') = ?2), ?7)
                        AND json_extract(r.payload, '$.kind') = ?3
                        AND json_extract(r.payload, '$.payload.type') = ?4
                        AND coalesce(json_extract(r.payload, '$.payload.agentId'), '') = ''
                      ORDER BY r.seq ASC
                      LIMIT 1)
             FROM conversation_events t
             WHERE t.thread_id = ?1 AND json_extract(t.payload, '$.kind') = ?2
             ORDER BY t.seq ASC",
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
            "SELECT session_id, seq, payload, recorded_at_unix_ms FROM conversation_events
             WHERE thread_id = ?1 AND seq >= ?2 AND seq < ?3
             ORDER BY seq ASC",
        )?;
        let read = statement
            .query_map(rusqlite::params![thread_id, lower, ceiling], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        let has_more = match floor {
            Some(floor) => self
                .connection
                .prepare_cached(
                    "SELECT EXISTS(
                       SELECT 1 FROM conversation_events
                       WHERE thread_id = ?1 AND seq < ?2
                         AND json_extract(payload, '$.kind') = ?3
                     )",
                )?
                .query_row(rusqlite::params![thread_id, floor, turn_start], |row| {
                    row.get::<_, bool>(0)
                })?,
            None => false,
        };
        let before = if has_more {
            read.first().map(|(session_id, seq, _, _)| FrameCursor {
                session_id: session_id.clone(),
                seq: *seq,
            })
        } else {
            None
        };

        let frames = read
            .into_iter()
            .map(|(session_id, seq, payload, at)| screen_frame(&session_id, seq, at, &payload))
            .collect::<serde_json::Result<Vec<_>>>()?;

        Ok(FramePage { frames, before })
    }

    /// 游标那一行的位置。内部编号不出这个 crate，翻译只在这里。
    fn frame_row(&self, thread: Uuid, cursor: &FrameCursor) -> Result<i64> {
        let mut statement = self.connection.prepare_cached(
            "SELECT seq FROM conversation_events
             WHERE thread_id = ?1 AND session_id = ?2 AND seq = ?3",
        )?;

        Ok(statement.query_row(
            rusqlite::params![thread.to_string(), cursor.session_id, cursor.seq],
            |row| row.get(0),
        )?)
    }

    /// 倒数第 drop_turns 轮起点那一行的位置；分叉复制以它为上界（不含）。
    ///
    /// drop_turns 为 0、或这条对话没有那么多轮时交回 i64::MAX —— 整条都在分叉
    /// 点之前。「哪一帧开一轮」由认识帧的那一侧回答（kap-client 的 frame.rs），
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
            "SELECT seq FROM conversation_events
             WHERE thread_id = ?1 AND json_extract(payload, '$.kind') = ?2
             ORDER BY seq DESC
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
}

/// 信封的格子并回载荷顶层：{sessionId, seq, at, kind, ...}。
///
/// 实时流（journal 的发布）与重放（这里的读）用同一个构造，两边不会各说各话。
/// `payload` 是事件联合已序列化的那一份 —— 与账本 payload 列同形。
///
/// # Errors
///
/// 载荷不是合法 JSON 时失败；落账的那份来自同一联合的序列化，正常不会发生。
pub fn screen_frame(
    session_id: &str,
    seq: i64,
    at: i64,
    payload: &str,
) -> serde_json::Result<Box<RawValue>> {
    let mut object = match serde_json::from_str::<serde_json::Value>(payload)? {
        serde_json::Value::Object(fields) => fields,
        _ => serde_json::Map::new(),
    };
    object.insert(
        String::from("sessionId"),
        serde_json::Value::String(session_id.to_owned()),
    );
    object.insert(String::from("seq"), serde_json::Value::from(seq));
    object.insert(String::from("at"), serde_json::Value::from(at));

    RawValue::from_string(serde_json::to_string(&object)?)
}
