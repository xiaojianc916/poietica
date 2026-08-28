//! 历史页的无损流压缩。原始 run_events 仍是唯一事实源。

use serde_json::{Value, value::RawValue, value::to_raw_value};

/// 回复正文那一格：kap 事件载荷的 type。目录的答与这里的合并读同一个判别式。
pub const ASSISTANT_DELTA: &str = "assistant.delta";

#[derive(PartialEq, Eq)]
struct DeltaKey {
    session_id: String,
    event_type: String,
    agent_id: Option<String>,
}

pub fn compact_history(frames: Vec<Box<RawValue>>) -> serde_json::Result<Vec<Box<RawValue>>> {
    let mut compacted = Vec::<Value>::with_capacity(frames.len());

    for frame in frames {
        let current = serde_json::from_str::<Value>(frame.get())?;
        if compacted
            .last_mut()
            .is_some_and(|previous| merge_delta(previous, &current))
        {
            continue;
        }
        compacted.push(current);
    }

    compacted
        .into_iter()
        .map(|value| to_raw_value(&value))
        .collect()
}

fn delta(value: &Value) -> Option<(DeltaKey, String)> {
    if value.get("kind")?.as_str()? != "kap_event" {
        return None;
    }
    let payload = value.get("payload")?.as_object()?;
    let event_type = payload.get("type")?.as_str()?;
    if event_type != ASSISTANT_DELTA && event_type != "thinking.delta" {
        return None;
    }

    Some((
        DeltaKey {
            session_id: value.get("sessionId")?.as_str()?.to_owned(),
            event_type: event_type.to_owned(),
            agent_id: payload
                .get("agentId")
                .and_then(Value::as_str)
                .filter(|agent| !agent.is_empty())
                .map(str::to_owned),
        },
        payload.get("delta")?.as_str()?.to_owned(),
    ))
}

fn merge_delta(previous: &mut Value, current: &Value) -> bool {
    let Some((previous_key, previous_text)) = delta(previous) else {
        return false;
    };
    let Some((current_key, current_text)) = delta(current) else {
        return false;
    };
    if previous_key != current_key {
        return false;
    }

    let Some(previous_object) = previous.as_object_mut() else {
        return false;
    };
    let Some(payload) = previous_object
        .get_mut("payload")
        .and_then(Value::as_object_mut)
    else {
        return false;
    };
    payload.insert(
        "delta".to_owned(),
        Value::String(format!("{previous_text}{current_text}")),
    );

    for field in ["seq", "at"] {
        if let Some(value) = current.get(field) {
            previous_object.insert(field.to_owned(), value.clone());
        }
    }
    true
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, reason = "a failed fixture must fail the test")]
    #![allow(
        clippy::indexing_slicing,
        reason = "fixtures index JSON whose shape this file wrote itself"
    )]

    use serde_json::{Value, json, value::to_raw_value};

    use super::compact_history;

    fn event(
        seq: i64,
        event_type: &str,
        text: &str,
        agent: Option<&str>,
    ) -> Box<serde_json::value::RawValue> {
        let mut payload = json!({ "type": event_type, "delta": text });
        if let Some(agent) = agent {
            payload["agentId"] = Value::String(agent.to_owned());
        }
        to_raw_value(&json!({
            "sessionId": "session-a",
            "seq": seq,
            "at": seq,
            "kind": "kap_event",
            "payload": payload,
        }))
        .expect("event")
    }

    #[test]
    fn adjacent_text_deltas_become_one_history_block() {
        let compacted = compact_history(vec![
            event(1, "assistant.delta", "a", None),
            event(2, "assistant.delta", "b", None),
            event(3, "assistant.delta", "c", None),
        ])
        .expect("compact");

        assert_eq!(compacted.len(), 1);
        let value: Value = serde_json::from_str(compacted[0].get()).expect("value");
        assert_eq!(value["payload"]["delta"], "abc");
        assert_eq!(value["seq"], 3);
        assert_eq!(value["at"], 3);
    }

    #[test]
    fn frame_kind_and_agent_boundaries_are_preserved() {
        let compacted = compact_history(vec![
            event(1, "assistant.delta", "a", None),
            event(2, "thinking.delta", "b", None),
            event(3, "assistant.delta", "c", Some("sub-1")),
            event(4, "assistant.delta", "d", None),
        ])
        .expect("compact");

        assert_eq!(compacted.len(), 4);
    }
}
