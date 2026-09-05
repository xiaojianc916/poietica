use std::collections::HashSet;
use crate::{AgentClient, KapError};
use crate::generated::completion::{
    CompletionItemsChoice as Item,
    CompletionItemsChoiceTurnStateEnum as TurnState,
    CompletionItemsChoiceTurnStepsFramesChoice as Frame,
    CompletionPromptsStatusEnum as PromptState,
    CompletionStruct,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PromptObservation { Active, Succeeded, Failed, Cancelled, Missing }

fn evidence(page: &CompletionStruct, wanted: &str) -> Option<PromptObservation> {
    for prompt in page.prompts().iter().filter(|prompt| prompt.prompt_id == wanted) {
        if prompt.steered_at.is_some() { continue; }
        let observed = match prompt.status {
            PromptState::Running | PromptState::Queued => PromptObservation::Active,
            PromptState::Blocked if prompt.finished_at.is_none() => PromptObservation::Active,
            PromptState::Completed if prompt.finished_at.is_some() => PromptObservation::Succeeded,
            PromptState::Failed | PromptState::Blocked if prompt.finished_at.is_some() => PromptObservation::Failed,
            PromptState::Aborted if prompt.finished_at.is_some() => PromptObservation::Cancelled,
            _ => PromptObservation::Missing,
        };
        return Some(observed);
    }
    let mut observed = None;
    for item in &page.items {
        let Item::Turn { trigger_prompt_id, state, ended_at, steps, .. } = item else { continue; };
        let steered = steps.iter().flat_map(|step| &step.frames).any(|frame| {
            matches!(frame, Frame::Text { prompt_ids: Some(ids) } if ids.iter().any(|id| id == wanted))
        });
        if trigger_prompt_id.as_deref() != Some(wanted) && !steered { continue; }
        let candidate = match state {
            TurnState::Queued | TurnState::Running => PromptObservation::Active,
            TurnState::Completed if ended_at.is_some() => PromptObservation::Succeeded,
            TurnState::Failed if ended_at.is_some() => PromptObservation::Failed,
            TurnState::Cancelled if ended_at.is_some() => PromptObservation::Cancelled,
            _ => PromptObservation::Missing,
        };
        if observed.is_some_and(|previous| previous != candidate) { return Some(PromptObservation::Missing); }
        observed = Some(candidate);
    }
    observed
}

pub async fn observe_prompt(client: &AgentClient, session: &str, wanted: &str) -> Result<PromptObservation, KapError> {
    let mut before = None;
    let mut visited = HashSet::new();
    loop {
        let value = client.read_transcript(session.to_owned(), "main".to_owned(), before).await?;
        let page: CompletionStruct = serde_json::from_value(value)
            .map_err(|error| KapError::Transport(format!("invalid completion evidence: {error}")))?;
        if page.agent_id != "main" { return Err(KapError::Transport("completion evidence belongs to another agent".to_owned())); }
        if let Some(observed) = evidence(&page, wanted) { return Ok(observed); }
        if !page.has_more { return Ok(PromptObservation::Missing); }
        let cursor = page.items.iter().find_map(|item| match item {
            Item::Turn { turn_id, .. } => Some(turn_id.clone()),
            _ => None,
        }).ok_or_else(|| KapError::Transport("transcript pagination has no turn cursor".to_owned()))?;
        if !visited.insert(cursor.clone()) { return Err(KapError::Transport("transcript pagination repeated its cursor".to_owned())); }
        before = Some(cursor);
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, reason = "invalid evidence fixtures must fail the test")]
    use super::*;
    use serde_json::{Value, json};
    fn page(items: Value, prompts: Value) -> CompletionStruct {
        serde_json::from_value(json!({"agent_id":"main", "has_more":false, "items":items, "prompts":prompts})).expect("wire evidence")
    }
    #[test]
    fn admission_and_an_unrelated_completion_are_not_success() {
        let observed = page(json!([{"kind":"turn","turnId":"t8","triggerPromptId":"another","state":"completed","endedAt":"2026-01-01T00:00:00Z","steps":[]}]), json!([]));
        assert_eq!(evidence(&observed, "wanted"), None);
    }
    #[test]
    fn a_cold_history_default_is_not_a_terminal_event() {
        let observed = page(json!([{"kind":"turn","turnId":"t0","triggerPromptId":"wanted","state":"completed","steps":[]}]), json!([]));
        assert_eq!(evidence(&observed, "wanted"), Some(PromptObservation::Missing));
    }
    #[test]
    fn steering_waits_for_the_identified_parent_turn() {
        let prompt = json!([{"promptId":"wanted","status":"completed","finishedAt":"2026-01-01T00:00:00Z","steeredAt":"2026-01-01T00:00:00Z"}]);
        assert_eq!(evidence(&page(json!([]), prompt.clone()), "wanted"), None);
        let frames = json!([{"frames":[{"kind":"text","promptIds":["wanted"]}]}]);
        let running = page(json!([{"kind":"turn","turnId":"t9","state":"running","steps":frames.clone()}]), prompt.clone());
        assert_eq!(evidence(&running, "wanted"), Some(PromptObservation::Active));
        let finished = page(json!([{"kind":"turn","turnId":"t9","state":"completed","endedAt":"2026-01-01T00:00:01Z","steps":frames}]), prompt);
        assert_eq!(evidence(&finished, "wanted"), Some(PromptObservation::Succeeded));
    }
    #[test]
    fn blocked_and_aborted_completion_are_not_success() {
        let blocked = page(json!([]), json!([{"promptId":"wanted","status":"blocked","finishedAt":"2026-01-01T00:00:00Z"}]));
        assert_eq!(evidence(&blocked, "wanted"), Some(PromptObservation::Failed));
        let aborted = page(json!([]), json!([{"promptId":"wanted","status":"aborted","finishedAt":"2026-01-01T00:00:00Z"}]));
        assert_eq!(evidence(&aborted, "wanted"), Some(PromptObservation::Cancelled));
    }
}
