//! 屏幕经过的读路：按轮分页、目录预览、分叉复制。
//!
//! 查询使用独立只读连接；payload 逐行解成领域事件，信封字段来自表列。

use std::collections::HashMap;

use poietica_conversation::event::{ConversationEvent, EventEnvelope};
use poietica_conversation::identity::{Seq, ThreadId};
use rusqlite::OptionalExtension;
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

/// 目录里「答」那一段从哪儿读。
///
/// 账本只知道载荷挂在 $.payload 下面；里面那几格叫什么、主代理的章是什么，
/// 由认识 kap 方言的那一层交进来（kap-client 的 history）。
#[derive(Debug)]
pub struct ReplyRead<'a> {
    pub type_field: &'a str,
    pub payload_type: &'a str,
    pub text_field: &'a str,
    pub agent_field: &'a str,
    pub main_agent: &'a str,
}

/// 一页帧，按追加顺序；`before` 缺席就是前面没有了。
#[derive(Debug)]
pub struct FramePage {
    /// 这一页的类型化事件；只在 IPC 边界序列化一次。
    pub frames: Vec<EventEnvelope>,
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
                   AND kind = ?3
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

    /// 这条对话的整本目录：一轮一行，按追加顺序。
    ///
    /// 问出自开轮那一帧。答是这一轮里主代理说出的字，按 seq 接起来再截到预览卡
    /// 装得下的字数 —— 一帧 delta 是一次流片（同一条判据见 history 的 compact_history），
    /// 取一帧就只有几个字。子代理的字不进这张卡。
    ///
    /// # Errors
    ///
    /// 查询被拒时返回错误。
    pub fn turn_marks(
        &self,
        thread: Uuid,
        from_seq: i64,
        turn_start: &str,
        event_kind: &str,
        reply: &ReplyRead<'_>,
        prompt_chars: i64,
        reply_chars: i64,
    ) -> Result<Vec<TurnMark>> {
        let thread_id = thread.to_string();

        let mut heads = self.connection.prepare_cached(
            "SELECT t.session_id, t.seq,
                    coalesce(json_extract(t.payload, '$.admissionId'), ''),
                    substr(coalesce(json_extract(t.payload, '$.prompt'), ''), 1, ?4)
             FROM conversation_events t
             WHERE t.thread_id = ?1 AND t.kind = ?2 AND t.seq >= ?3
             ORDER BY t.seq ASC",
        )?;

        let mut marks = heads
            .query_map(
                rusqlite::params![thread_id, turn_start, from_seq, prompt_chars],
                |row| {
                    Ok(TurnMark {
                        session_id: row.get(0)?,
                        seq: row.get(1)?,
                        admission_id: row.get(2)?,
                        prompt: row.get(3)?,
                        reply: None,
                    })
                },
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        /* 每一轮只取够填满预览卡的前几片：留下的片各至少一个字，所以取
        reply_chars 片必然够。窗口函数与 fork_thread 的 ROW_NUMBER 同源。 */
        let mut flakes = self.connection.prepare_cached(
            "WITH ordered AS (
               SELECT seq, kind, payload,
                      MAX(CASE WHEN kind = ?2 THEN seq END) OVER (
                        ORDER BY seq ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                      ) AS turn_seq
                 FROM conversation_events
                WHERE thread_id = ?1 AND seq >= ?3
             ), reply_flakes AS (
               SELECT turn_seq,
                      json_extract(payload, '$.payload.' || ?5) AS text,
                      ROW_NUMBER() OVER (PARTITION BY turn_seq ORDER BY seq) AS rank
                 FROM ordered
                WHERE turn_seq IS NOT NULL
                  AND kind = ?4
                  AND json_extract(payload, '$.payload.' || ?6) = ?7
                  AND coalesce(json_extract(payload, '$.payload.' || ?8), '') IN ('', ?9)
             )
             SELECT turn_seq, text
               FROM reply_flakes
              WHERE text IS NOT NULL AND text <> '' AND rank <= ?10
              ORDER BY turn_seq ASC, rank ASC",
        )?;

        let spoken = flakes
            .query_map(
                rusqlite::params![
                    thread_id,
                    turn_start,
                    from_seq,
                    event_kind,
                    reply.text_field,
                    reply.type_field,
                    reply.payload_type,
                    reply.agent_field,
                    reply.main_agent,
                    reply_chars
                ],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        let budget = usize::try_from(reply_chars.max(0)).unwrap_or(usize::MAX);
        let mut said = replies_of(&spoken, budget);

        for mark in &mut marks {
            mark.reply = said.remove(&mark.seq);
        }

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
        let (frames, first) = {
            let mut rows = statement.query(rusqlite::params![thread_id, lower, ceiling])?;
            let mut frames = Vec::new();
            let mut first = None;

            while let Some(row) = rows.next()? {
                let session_id = row.get::<_, Option<String>>(0)?.unwrap_or_default();
                let seq = row.get::<_, i64>(1)?;
                let payload = row.get::<_, String>(2)?;
                let at = row.get::<_, i64>(3)?;

                if first.is_none() {
                    first = Some((session_id.clone(), seq));
                }
                frames.push(screen_frame(thread_id, &session_id, seq, at, &payload)?);
            }
            (frames, first)
        };

        let has_more = match floor {
            Some(floor) => self
                .connection
                .prepare_cached(
                    "SELECT EXISTS(
                       SELECT 1 FROM conversation_events
                       WHERE thread_id = ?1 AND seq < ?2
                         AND kind = ?3
                     )",
                )?
                .query_row(rusqlite::params![thread_id, floor, turn_start], |row| {
                    row.get::<_, bool>(0)
                })?,
            None => false,
        };
        let before = if has_more {
            first.map(|(session_id, seq)| FrameCursor { session_id, seq })
        } else {
            None
        };

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
    /// kind 值因此由调用方交进来；这一层只按账本列定位。
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
             WHERE thread_id = ?1 AND kind = ?2
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

/// 把账本行还原成领域信封。载荷直接反序列化为封闭事件联合。
///
/// # Errors
///
/// 载荷不符合 ConversationEvent 契约时失败。
pub fn screen_frame(
    thread_id: &str,
    session_id: &str,
    seq: i64,
    at: i64,
    payload: &str,
) -> serde_json::Result<EventEnvelope> {
    Ok(EventEnvelope {
        thread: ThreadId::new(thread_id.to_owned()),
        seq: Seq::new(u64::try_from(seq).unwrap_or(0)),
        at,
        session_id: session_id.to_owned(),
        event: serde_json::from_str::<ConversationEvent>(payload)?,
    })
}

/// 每一轮的答：同一轮的流片按到达顺序接起来，接满预览卡就收手。
///
/// 截断按字符而不是字节：这一格装的是中文。行数由 CSS 的行高与 max-block-size
/// 决定，库这边只保证字数够填满它。
fn replies_of(rows: &[(i64, String)], budget: usize) -> HashMap<i64, String> {
    let mut said: HashMap<i64, String> = HashMap::new();

    if budget == 0 {
        return said;
    }

    for (turn, text) in rows {
        let held = said.entry(*turn).or_default();

        if held.chars().count() >= budget {
            continue;
        }

        held.push_str(text);
    }

    for text in said.values_mut() {
        if text.chars().count() > budget {
            *text = text.chars().take(budget).collect();
        }
    }

    said
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        reason = "a malformed replay fixture must fail the test"
    )]

    use poietica_conversation::event::ConversationEvent;
    use poietica_conversation::identity::Seq;
    use serde_json::json;

    use super::{replies_of, screen_frame};

    #[test]
    fn replay_decodes_the_event_union_and_rejects_unknown_shapes() {
        let payload = serde_json::to_string(&ConversationEvent::KapEvent {
            payload: json!({ "type": "assistant.delta", "delta": "hello" }),
        })
        .expect("payload");
        let frame = screen_frame("thread", "session", 7, 9, &payload).expect("frame");

        assert_eq!(frame.seq, Seq::new(7));
        assert!(matches!(frame.event, ConversationEvent::KapEvent { .. }));
        assert!(screen_frame("thread", "session", 8, 10, "{}").is_err());
    }

    #[test]
    fn a_turn_reply_is_every_flake_it_said_in_order() {
        let rows = vec![
            (10, "你".to_owned()),
            (10, "好".to_owned()),
            (10, "，世界".to_owned()),
        ];

        assert_eq!(
            replies_of(&rows, 96).get(&10).map(String::as_str),
            Some("你好，世界")
        );
    }

    #[test]
    fn the_budget_counts_characters_and_turns_do_not_bleed() {
        let rows = vec![(1, "一二三四".to_owned()), (2, "五六".to_owned())];
        let said = replies_of(&rows, 3);

        assert_eq!(said.get(&1).map(String::as_str), Some("一二三"));
        assert_eq!(said.get(&2).map(String::as_str), Some("五六"));
    }
}
