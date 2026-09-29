//! 会话生命周期那条应答的形状：「换出会话」的那个号。
//!
//! 与 bridge.rs 分家按 AGENTS.md §4 的拆分判据：这里只读「会话的增删查导」这一类
//! 应答的形状，而 bridge.rs 是传输驱动器（命令配对、进程、事件派发）。选择器的解码
//! 不在这里 —— 那是另一类事实，产地仍只有 bridge.rs 的 `controls_of` 一处。
//!
//! 形状的产地是 packages/agent-bridge/src/protocol.ts 的 BridgeCommand 那一支；
//! 本模块只在应答回来的那一刻解它，此后本层不再看 JSON。

use serde_json::Value;

use crate::error::{AgentError, Refusal, Result};

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

    use super::a_session_id;
    use crate::error::{AgentError, Refusal};
    use serde_json::json;

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
