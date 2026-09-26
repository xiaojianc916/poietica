//! 会话生命周期那几条应答的形状：清单一条，以及「换出会话」的那条号。
//!
//! 与 bridge.rs 分家按 AGENTS.md §4 的拆分判据：这里只读「会话的增删查导」这一类
//! 应答的形状，而 bridge.rs 是传输驱动器（命令配对、进程、事件派发）。选择器的解码
//! 不在这里 —— 那是另一类事实，产地仍只有 bridge.rs 的 `controls_of` 一处。
//!
//! 形状的产地是 packages/agent-bridge/src/protocol.ts 的 BridgeCommand 那一支；
//! 本模块只在应答回来的那一刻解它，此后本层不再看 JSON。

use serde_json::Value;

use crate::error::{AgentError, Refusal, Result};
use crate::session::SessionEntry;

/// 桥报的会话清单 → 产品条目。
///
/// 缺格如实跳过，不补默认：清单里的一行没有号就没法装载，编一个是假条目。
/// `title` 与 `updatedAt` 可缺席也可为 null —— 未命名的会话本就不报标题。
pub(crate) fn entries_of(data: &Value) -> Vec<SessionEntry> {
    data.get("sessions")
        .and_then(Value::as_array)
        .map(|sessions| sessions.iter().filter_map(entry_of).collect())
        .unwrap_or_default()
}

fn entry_of(value: &Value) -> Option<SessionEntry> {
    Some(SessionEntry {
        session_id: value.get("sessionId")?.as_str()?.to_owned(),
        title: value
            .get("title")
            .and_then(Value::as_str)
            .map(str::to_owned),
        updated_at: value
            .get("updatedAt")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

/// 一次换出会话（新开、重装、分叉）的应答里那个号。
///
/// 三条命令共用这一格：号缺席即这次换会话没有发生。报 `UnknownSession` 而不是回一个
/// 空串 —— 空号会让上层把账写到一条不存在的会话上，而那是分叉最坏的结局。
pub(crate) fn a_session_id(data: &Value) -> Result<String> {
    data.get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or(AgentError::Refused(Refusal::UnknownSession))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, reason = "a broken fixture must fail loudly")]

    use super::{a_session_id, entries_of};
    use crate::error::{AgentError, Refusal};
    use serde_json::json;

    #[test]
    fn a_listing_keeps_the_id_the_title_and_the_stamp() {
        let entries = entries_of(&json!({
            "sessions": [
                { "sessionId": "s1", "title": "发布", "updatedAt": "2026-01-02T03:04:05.000Z" },
                { "sessionId": "s2", "title": null, "updatedAt": null },
            ],
        }));

        let [first, second] = entries.as_slice() else {
            unreachable!("two sessions must decode into two entries")
        };

        assert_eq!(first.session_id, "s1");
        assert_eq!(first.title.as_deref(), Some("发布"));
        assert_eq!(
            first.updated_at.as_deref(),
            Some("2026-01-02T03:04:05.000Z")
        );
        /* 未命名的会话不报标题：null 与「这一格是空串」在界面上不是一回事。 */
        assert!(second.title.is_none());
        assert!(second.updated_at.is_none());
    }

    /// 一行没有号就没法装载；跳过它，不编一个号出来。
    #[test]
    fn a_listing_row_without_an_id_is_dropped() {
        let entries = entries_of(&json!({
            "sessions": [{ "title": "没有号" }, { "sessionId": "s2" }],
        }));

        let [only] = entries.as_slice() else {
            unreachable!("the row without an id must be dropped, leaving exactly one")
        };

        assert_eq!(only.session_id, "s2");
    }

    /// 桥没报清单与桥报了一张空清单，在下游都是「一条都没有」。
    #[test]
    fn a_listing_that_is_absent_is_an_empty_list() {
        assert!(entries_of(&json!({})).is_empty());
        assert!(entries_of(&json!({ "sessions": null })).is_empty());
    }

    #[test]
    fn an_exchange_names_the_session_it_moved_to() {
        assert_eq!(
            a_session_id(&json!({ "sessionId": "s9" })).expect("a named session must decode"),
            "s9"
        );
    }

    /// 没有号就是没有会话：分叉没成时如实报，别回一个空串让上层接着写账。
    #[test]
    fn an_exchange_without_a_session_id_is_refused() {
        assert!(matches!(
            a_session_id(&json!({ "controls": [] })),
            Err(AgentError::Refused(Refusal::UnknownSession))
        ));
        assert!(matches!(
            a_session_id(&json!({ "sessionId": null })),
            Err(AgentError::Refused(Refusal::UnknownSession))
        ));
    }
}
