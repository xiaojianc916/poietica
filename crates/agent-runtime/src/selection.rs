use std::collections::HashSet;
use std::time::Duration;

use futures::channel::oneshot;

use crate::commands::AgentClient;
use crate::config::{ConfigControl, ConfigPurpose, selector_patch};
use crate::error::{KapError, Refusal, Result};

const SETTLE_ATTEMPTS: usize = 20;
const SETTLE_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigSelection {
    pub id: String,
    pub value: String,
}

/// Validates the complete prompt configuration before writing any selector,
/// skips values already in force, and returns the one authoritative table.
pub async fn apply_configurations(
    client: &AgentClient,
    session_id: String,
    selections: Vec<ConfigSelection>,
    input: Option<String>,
) -> Result<Vec<ConfigControl>> {
    let mut ids = HashSet::new();
    for selection in &selections {
        if !ids.insert(selection.id.as_str()) {
            return Err(KapError::Validation {
                message: format!("prompt configuration repeats selector {}", selection.id),
            });
        }
        let _validated = selector_patch(&selection.id, &selection.value, input.as_deref())?;
    }

    let mut controls = receive(client.selectors(session_id.clone())?).await?;
    for selection in selections {
        if controls
            .iter()
            .any(|control| control.id == selection.id && control.current == selection.value)
        {
            continue;
        }
        controls = select_config(
            client,
            session_id.clone(),
            selection.id,
            selection.value,
            input.clone(),
        )
        .await?;
    }
    Ok(controls)
}

/// Changes one session control and waits until the agent reports that value as
/// effective. A model change is a compound transaction: after the model has
/// settled, the target model's resolved Thinking value is explicitly applied.
/// This keeps model, Thinking and the selector table on one authoritative line.
pub async fn select_config(
    client: &AgentClient,
    session_id: String,
    config_id: String,
    value: String,
    input: Option<String>,
) -> Result<Vec<ConfigControl>> {
    let answer = client.select(session_id.clone(), config_id.clone(), value.clone(), input)?;
    let controls = receive(answer).await?;
    let controls = settle(client, &session_id, &config_id, &value, controls).await?;

    let changed_model = controls
        .iter()
        .any(|control| control.id == config_id && control.purpose == ConfigPurpose::Model);

    if !changed_model {
        return Ok(controls);
    }

    let Some((thinking_id, thinking_value)) = controls
        .iter()
        .find(|control| control.purpose == ConfigPurpose::Thought)
        .map(|control| (control.id.clone(), control.current.clone()))
    else {
        return Ok(controls);
    };

    let answer = client.select(
        session_id.clone(),
        thinking_id.clone(),
        thinking_value.clone(),
        None,
    )?;
    let controls = receive(answer).await?;

    settle(client, &session_id, &thinking_id, &thinking_value, controls).await
}

async fn settle(
    client: &AgentClient,
    session_id: &str,
    config_id: &str,
    value: &str,
    mut controls: Vec<ConfigControl>,
) -> Result<Vec<ConfigControl>> {
    for attempt in 0..SETTLE_ATTEMPTS {
        if controls
            .iter()
            .any(|control| control.id == config_id && control.current == value)
        {
            return Ok(controls);
        }

        if attempt + 1 == SETTLE_ATTEMPTS {
            break;
        }

        tokio::time::sleep(SETTLE_INTERVAL).await;
        let answer = client.selectors(session_id.to_owned())?;
        controls = receive(answer).await?;
    }

    Err(KapError::Timeout {
        message: format!("session {session_id} did not settle selector {config_id} on {value}"),
    })
}

async fn receive(
    answer: oneshot::Receiver<Result<Vec<ConfigControl>>>,
) -> Result<Vec<ConfigControl>> {
    answer
        .await
        .map_err(|_dropped| KapError::Refused(Refusal::Gone))?
}

#[cfg(test)]
mod tests {
    use futures::StreamExt;

    use super::*;
    use crate::commands::Command;
    use crate::config::ConfigChoice;

    fn control(id: &str, purpose: ConfigPurpose, current: &str, choices: &[&str]) -> ConfigControl {
        ConfigControl {
            id: id.to_owned(),
            label: id.to_owned(),
            detail: None,
            purpose,
            applies_on_submit: false,
            current: current.to_owned(),
            choices: choices
                .iter()
                .map(|value| ConfigChoice {
                    value: (*value).to_owned(),
                    label: (*value).to_owned(),
                    detail: None,
                })
                .collect(),
        }
    }

    fn target_controls() -> Vec<ConfigControl> {
        vec![
            control(
                "model",
                ConfigPurpose::Model,
                "deepseek",
                &["k3", "deepseek"],
            ),
            control("thinking", ConfigPurpose::Thought, "high", &["high", "max"]),
        ]
    }

    #[tokio::test]
    async fn model_selection_settles_then_applies_target_thinking() {
        let (commands, mut received) = futures::channel::mpsc::unbounded();
        let client = AgentClient::new(commands);
        let selecting = tokio::spawn(async move {
            select_config(
                &client,
                "session".to_owned(),
                "model".to_owned(),
                "deepseek".to_owned(),
                None,
            )
            .await
        });

        let Some(Command::Select { reply, .. }) = received.next().await else {
            return;
        };
        reply
            .send(Ok(vec![
                control("model", ConfigPurpose::Model, "k3", &["k3", "deepseek"]),
                control(
                    "thinking",
                    ConfigPurpose::Thought,
                    "low",
                    &["low", "high", "max"],
                ),
            ]))
            .expect("model response");

        let Some(Command::Selectors { reply, .. }) = received.next().await else {
            return;
        };
        reply.send(Ok(target_controls())).expect("settled model");

        let Some(Command::Select {
            config_id,
            value,
            reply,
            ..
        }) = received.next().await
        else {
            return;
        };
        assert_eq!(config_id, "thinking");
        assert_eq!(value, "high");
        reply
            .send(Ok(target_controls()))
            .expect("Thinking response");

        let result = selecting.await.expect("selection task").expect("selection");
        let thought = result
            .iter()
            .find(|control| control.purpose == ConfigPurpose::Thought)
            .expect("Thinking control");

        assert_eq!(thought.current, "high");
        assert!(thought.choices.iter().all(|choice| choice.value != "low"));
    }

    #[tokio::test]
    async fn model_without_thinking_finishes_without_second_write() {
        let (commands, mut received) = futures::channel::mpsc::unbounded();
        let client = AgentClient::new(commands);
        let selecting = tokio::spawn(async move {
            select_config(
                &client,
                "session".to_owned(),
                "model".to_owned(),
                "plain".to_owned(),
                None,
            )
            .await
        });

        let Some(Command::Select { reply, .. }) = received.next().await else {
            return;
        };
        reply
            .send(Ok(vec![control(
                "model",
                ConfigPurpose::Model,
                "plain",
                &["plain"],
            )]))
            .expect("model response");

        let result = selecting.await.expect("selection task").expect("selection");
        assert!(
            result
                .iter()
                .all(|control| control.purpose != ConfigPurpose::Thought)
        );
    }
}
