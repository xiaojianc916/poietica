use crate::generated::completion::{
    CompletionItemsChoice as Item, CompletionItemsChoiceTurnStateEnum as TurnState,
    CompletionItemsChoiceTurnStepsFramesChoice as Frame,
    CompletionPromptsStatusEnum as PromptState, CompletionStruct,
};
use crate::{AgentClient, KapError};
use std::collections::HashSet;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PromptObservation {
    Active,
    Succeeded,
    Failed,
    Cancelled,
    Missing,
}

fn combine(previous: Option<PromptObservation>, candidate: PromptObservation) -> PromptObservation {
    match previous {
        None | Some(PromptObservation::Missing) => candidate,
        Some(previous) if previous == candidate => candidate,
        // Incomplete cold projections cannot disprove identified, finished evidence.
        Some(previous) if candidate == PromptObservation::Missing => previous,
        Some(_) => PromptObservation::Missing,
    }
}

fn evidence(page: &CompletionStruct, wanted: &str) -> Option<PromptObservation> {
    let mut observed = None;
    let mut conflict = false;
    let mut add = |candidate| {
        if let Some(previous) = observed
            && previous != PromptObservation::Missing
            && candidate != PromptObservation::Missing
            && previous != candidate
        {
            conflict = true;
        }
        observed = Some(combine(observed, candidate));
    };
    for prompt in page
        .prompts()
        .iter()
        .filter(|prompt| prompt.prompt_id == wanted)
    {
        if prompt.steered_at.is_some() {
            continue;
        }
        add(match prompt.status {
            PromptState::Running | PromptState::Queued => PromptObservation::Active,
            PromptState::Blocked if prompt.finished_at.is_none() => PromptObservation::Active,
            PromptState::Completed if prompt.finished_at.is_some() => PromptObservation::Succeeded,
            PromptState::Failed | PromptState::Blocked if prompt.finished_at.is_some() => {
                PromptObservation::Failed
            }
            PromptState::Aborted if prompt.finished_at.is_some() => PromptObservation::Cancelled,
            _ => PromptObservation::Missing,
        });
    }
    for item in &page.items {
        let Item::Turn {
            trigger_prompt_id,
            state,
            ended_at,
            steps,
            ..
        } = item
        else {
            continue;
        };
        let steered = steps.iter().flat_map(|step| &step.frames).any(|frame| {
            matches!(frame, Frame::Text { prompt_ids: Some(ids) } if ids.iter().any(|id| id == wanted))
        });
        if trigger_prompt_id.as_deref() != Some(wanted) && !steered {
            continue;
        }
        add(match state {
            TurnState::Queued | TurnState::Running => PromptObservation::Active,
            TurnState::Completed if ended_at.is_some() => PromptObservation::Succeeded,
            TurnState::Failed if ended_at.is_some() => PromptObservation::Failed,
            TurnState::Cancelled if ended_at.is_some() => PromptObservation::Cancelled,
            _ => PromptObservation::Missing,
        });
    }
    if conflict {
        Some(PromptObservation::Missing)
    } else {
        observed
    }
}

pub async fn observe_prompt(
    client: &AgentClient,
    session: &str,
    wanted: &str,
) -> Result<PromptObservation, KapError> {
    let mut before = None;
    let mut visited = HashSet::new();
    loop {
        let value = client
            .read_transcript(session.to_owned(), "main".to_owned(), before)
            .await?;
        let page: CompletionStruct =
            serde_json::from_value(value).map_err(|error| KapError::Transport {
                message: format!("invalid completion evidence: {error}"),
            })?;
        if page.agent_id != "main" {
            return Err(KapError::Transport {
                message: "completion evidence belongs to another agent".to_owned(),
            });
        }
        if let Some(observed) = evidence(&page, wanted) {
            return Ok(observed);
        }
        if !page.has_more {
            return Ok(PromptObservation::Missing);
        }
        let cursor = page
            .items
            .iter()
            .find_map(|item| match item {
                Item::Turn { turn_id, .. } => Some(turn_id.clone()),
                _ => None,
            })
            .ok_or_else(|| KapError::Transport {
                message: "transcript pagination has no turn cursor".to_owned(),
            })?;
        if !visited.insert(cursor.clone()) {
            return Err(KapError::Transport {
                message: "transcript pagination repeated its cursor".to_owned(),
            });
        }
        before = Some(cursor);
    }
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        reason = "invalid evidence fixtures must fail the test"
    )]
    use super::*;
    use serde_json::{Value, json};
    fn page(items: &Value, prompts: &Value) -> CompletionStruct {
        serde_json::from_value(
            json!({"agent_id":"main", "has_more":false, "items":items, "prompts":prompts}),
        )
        .expect("wire evidence")
    }
    #[test]
    fn admission_and_an_unrelated_completion_are_not_success() {
        let observed = page(
            &json!([{"kind":"turn","turnId":"t8","triggerPromptId":"another","state":"completed","endedAt":"2026-01-01T00:00:00Z","steps":[]}]),
            &json!([]),
        );
        assert_eq!(evidence(&observed, "wanted"), None);
    }
    #[test]
    fn a_cold_history_default_is_not_a_terminal_event() {
        let observed = page(
            &json!([{"kind":"turn","turnId":"t0","triggerPromptId":"wanted","state":"completed","steps":[]}]),
            &json!([]),
        );
        assert_eq!(
            evidence(&observed, "wanted"),
            Some(PromptObservation::Missing)
        );
    }
    #[test]
    fn steering_waits_for_the_identified_parent_turn() {
        let prompt = json!([{"promptId":"wanted","status":"completed","finishedAt":"2026-01-01T00:00:00Z","steeredAt":"2026-01-01T00:00:00Z"}]);
        assert_eq!(evidence(&page(&json!([]), &prompt), "wanted"), None);
        let frames = json!([{"frames":[{"kind":"text","promptIds":["wanted"]}]}]);
        let running = page(
            &json!([{"kind":"turn","turnId":"t9","state":"running","steps":frames.clone()}]),
            &prompt,
        );
        assert_eq!(
            evidence(&running, "wanted"),
            Some(PromptObservation::Active)
        );
        let finished = page(
            &json!([{"kind":"turn","turnId":"t9","state":"completed","endedAt":"2026-01-01T00:00:01Z","steps":frames}]),
            &prompt,
        );
        assert_eq!(
            evidence(&finished, "wanted"),
            Some(PromptObservation::Succeeded)
        );
    }
    #[test]
    fn blocked_and_aborted_completion_are_not_success() {
        let blocked = page(
            &json!([]),
            &json!([{"promptId":"wanted","status":"blocked","finishedAt":"2026-01-01T00:00:00Z"}]),
        );
        assert_eq!(
            evidence(&blocked, "wanted"),
            Some(PromptObservation::Failed)
        );
        let aborted = page(
            &json!([]),
            &json!([{"promptId":"wanted","status":"aborted","finishedAt":"2026-01-01T00:00:00Z"}]),
        );
        assert_eq!(
            evidence(&aborted, "wanted"),
            Some(PromptObservation::Cancelled)
        );
    }

    #[test]
    fn incomplete_prompt_metadata_does_not_hide_an_identified_finished_turn() {
        let observed = page(
            &json!([{"kind":"turn","turnId":"t1","triggerPromptId":"wanted","state":"completed","endedAt":"2026-01-01T00:00:00Z","steps":[]}]),
            &json!([{"promptId":"wanted","status":"completed"}]),
        );
        assert_eq!(
            evidence(&observed, "wanted"),
            Some(PromptObservation::Succeeded)
        );
    }
    #[test]
    fn contradictory_finished_evidence_is_not_settled() {
        let observed = page(
            &json!([{"kind":"turn","turnId":"t1","triggerPromptId":"wanted","state":"failed","endedAt":"2026-01-01T00:00:00Z","steps":[]}]),
            &json!([{"promptId":"wanted","status":"completed","finishedAt":"2026-01-01T00:00:00Z"}]),
        );
        assert_eq!(
            evidence(&observed, "wanted"),
            Some(PromptObservation::Missing)
        );
    }
}
