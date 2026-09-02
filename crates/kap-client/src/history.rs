//! 历史页的类型化流压缩。事件账是唯一事实源。

use poietica_conversation::event::{ConversationEvent, EventEnvelope};
use serde_json::Value;

pub const ASSISTANT_DELTA: &str = "assistant.delta";
pub const TYPE_FIELD: &str = "type";
pub const DELTA_FIELD: &str = "delta";
pub const AGENT_FIELD: &str = "agentId";
pub const MAIN_AGENT: &str = "main";

#[derive(PartialEq, Eq)]
struct DeltaKey<'a> {
    session_id: &'a str,
    event_type: &'a str,
    agent_id: Option<&'a str>,
}

fn delta(frame: &EventEnvelope) -> Option<(DeltaKey<'_>, &str)> {
    let ConversationEvent::KapEvent { payload } = &frame.event else {
        return None;
    };
    let event_type = payload.get(TYPE_FIELD)?.as_str()?;
    if event_type != ASSISTANT_DELTA && event_type != "thinking.delta" {
        return None;
    }
    Some((
        DeltaKey {
            session_id: &frame.session_id,
            event_type,
            agent_id: payload
                .get(AGENT_FIELD)
                .and_then(Value::as_str)
                .filter(|agent| !agent.is_empty()),
        },
        payload.get(DELTA_FIELD)?.as_str()?,
    ))
}

pub fn compact_history(frames: Vec<EventEnvelope>) -> Vec<EventEnvelope> {
    let mut compacted = Vec::new();
    for frame in frames {
        if compacted
            .last_mut()
            .is_some_and(|previous| merge_delta(previous, &frame))
        {
            continue;
        }
        compacted.push(frame);
    }
    compacted
}

fn merge_delta(previous: &mut EventEnvelope, current: &EventEnvelope) -> bool {
    let compatible = match (delta(previous), delta(current)) {
        (Some((previous, _)), Some((current, _))) => previous == current,
        _ => false,
    };
    if !compatible {
        return false;
    }
    let Some((_, current_text)) = delta(current) else {
        return false;
    };
    let ConversationEvent::KapEvent { payload } = &mut previous.event else {
        return false;
    };
    let Some(Value::String(previous_text)) = payload.get_mut(DELTA_FIELD) else {
        return false;
    };

    previous_text.push_str(current_text);
    previous.seq = current.seq;
    previous.at = current.at;
    true
}

#[cfg(test)]
mod tests {
    use poietica_conversation::event::{ConversationEvent, EventEnvelope};
    use poietica_conversation::identity::{Seq, ThreadId};
    use serde_json::{Value, json};

    use super::compact_history;

    fn event(seq: u64, event_type: &str, text: &str, agent: Option<&str>) -> EventEnvelope {
        let payload = match agent {
            Some(agent) => json!({ "type": event_type, "delta": text, "agentId": agent }),
            None => json!({ "type": event_type, "delta": text }),
        };
        EventEnvelope {
            thread: ThreadId::new("thread-a".to_owned()),
            seq: Seq::new(seq),
            at: i64::try_from(seq).unwrap_or(i64::MAX),
            session_id: "session-a".to_owned(),
            event: ConversationEvent::KapEvent { payload },
        }
    }

    #[test]
    fn adjacent_text_deltas_append_in_place() {
        let compacted = compact_history(vec![
            event(1, "assistant.delta", "a", None),
            event(2, "assistant.delta", "b", None),
            event(3, "assistant.delta", "c", None),
        ]);
        assert_eq!(compacted.len(), 1);
        let text = compacted.first().and_then(|frame| match &frame.event {
            ConversationEvent::KapEvent { payload } => payload.get("delta").and_then(Value::as_str),
            _ => None,
        });
        assert_eq!(text, Some("abc"));
        assert_eq!(compacted.first().map(|frame| frame.seq), Some(Seq::new(3)));
    }

    #[test]
    fn frame_kind_and_agent_boundaries_are_preserved() {
        let compacted = compact_history(vec![
            event(1, "assistant.delta", "a", None),
            event(2, "thinking.delta", "b", None),
            event(3, "assistant.delta", "c", Some("sub-1")),
            event(4, "assistant.delta", "d", None),
        ]);
        assert_eq!(compacted.len(), 4);
    }
}
