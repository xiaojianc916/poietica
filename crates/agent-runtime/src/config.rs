use serde_json::{Value, json};

/// One value offered by an agent-owned configuration control.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigChoice {
    pub value: String,
    pub label: String,
    pub detail: Option<String>,
}

/// What a selector changes. Presentation chooses placement from this semantic
/// purpose; it never guesses from an id or label.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfigPurpose {
    Mode,
    Model,
    Thought,
    Other,
}

/// One configuration control, including its effective value and complete
/// accepted domain.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigControl {
    pub id: String,
    pub label: String,
    pub detail: Option<String>,
    pub purpose: ConfigPurpose,
    pub current: String,
    pub choices: Vec<ConfigChoice>,
}

#[derive(Debug)]
struct ThinkingOffer {
    current: String,
    choices: Vec<ConfigChoice>,
}

/// Projects KAP status and model metadata into one internally consistent table.
/// `support_efforts` is the only source for named efforts; stale values from a
/// previous model are resolved before they reach the contract.
#[must_use]
pub fn controls(status: &Value, catalog: &Value) -> Vec<ConfigControl> {
    let items = catalog.get("items").and_then(Value::as_array);
    let mut offered = Vec::with_capacity(3);

    if let Some(control) = model_control(status, items) {
        offered.push(control);
    }

    if let Some(control) = thinking_control(status, items) {
        offered.push(control);
    }

    if let Some(control) = mode_control(status) {
        offered.push(control);
    }

    offered
}

fn model_control(status: &Value, items: Option<&Vec<Value>>) -> Option<ConfigControl> {
    let current = non_empty(status.get("model")?.as_str()?)?;
    let items = items?;
    let mut choices = Vec::with_capacity(items.len());

    for item in items {
        let Some(model) = item.get("model").and_then(Value::as_str).and_then(non_empty) else {
            continue;
        };
        let label = item
            .get("display_name")
            .and_then(Value::as_str)
            .and_then(non_empty)
            .unwrap_or(model);

        push_unique(&mut choices, choice(model, label));
    }

    if choices.is_empty() {
        return None;
    }

    if !choices.iter().any(|choice| choice.value == current) {
        choices.push(choice(current, current));
    }

    Some(ConfigControl {
        id: "model".to_owned(),
        label: "Model".to_owned(),
        detail: None,
        purpose: ConfigPurpose::Model,
        current: current.to_owned(),
        choices,
    })
}

fn thinking_control(status: &Value, items: Option<&Vec<Value>>) -> Option<ConfigControl> {
    let model = non_empty(status.get("model")?.as_str()?)?;
    let reported = status
        .get("thinking_level")
        .and_then(Value::as_str)
        .and_then(non_empty);
    let offer = thinking_offer(model, reported, items?)?;

    Some(ConfigControl {
        id: "thinking".to_owned(),
        label: "Thinking".to_owned(),
        detail: None,
        purpose: ConfigPurpose::Thought,
        current: offer.current,
        choices: offer.choices,
    })
}

fn thinking_offer(
    model: &str,
    reported: Option<&str>,
    items: &[Value],
) -> Option<ThinkingOffer> {
    let item = items
        .iter()
        .find(|item| item.get("model").and_then(Value::as_str) == Some(model))?;

    let capabilities = item
        .get("capabilities")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    let supports_thinking = capabilities.iter().any(|capability| {
        matches!(capability.as_str(), Some("thinking" | "always_thinking"))
    });
    let always_thinking = capabilities
        .iter()
        .any(|capability| capability.as_str() == Some("always_thinking"));

    let efforts = item.get("support_efforts").and_then(Value::as_array);
    let mut choices = Vec::new();

    if let Some(efforts) = efforts {
        for effort in efforts {
            let Some(value) = effort.as_str().and_then(non_empty) else {
                continue;
            };
            push_unique(&mut choices, choice(value, value));
        }
    }

    if !choices.is_empty() {
        let current = reported
            .filter(|value| contains(&choices, value))
            .or_else(|| {
                item.get("default_effort")
                    .and_then(Value::as_str)
                    .and_then(non_empty)
                    .filter(|value| contains(&choices, value))
            })
            .or_else(|| {
                choices
                    .get(choices.len() / 2)
                    .map(|choice| choice.value.as_str())
            })?;

        return Some(ThinkingOffer {
            current: current.to_owned(),
            choices,
        });
    }

    if !supports_thinking {
        return None;
    }

    choices.push(choice("on", "on"));
    if !always_thinking {
        choices.push(choice("off", "off"));
    }

    let current = reported
        .filter(|value| contains(&choices, value))
        .unwrap_or("on")
        .to_owned();

    Some(ThinkingOffer { current, choices })
}

fn mode_control(status: &Value) -> Option<ConfigControl> {
    let current = non_empty(status.get("approval_mode")?.as_str()?)?;
    let modes = status.get("available_approval_modes")?.as_array()?;
    let mut choices = Vec::with_capacity(modes.len());

    for mode in modes {
        let Some(mode) = mode.as_str().and_then(non_empty) else {
            continue;
        };
        push_unique(&mut choices, choice(mode, mode_label(mode)));
    }

    if choices.is_empty() {
        return None;
    }

    if !choices.iter().any(|choice| choice.value == current) {
        choices.push(choice(current, mode_label(current)));
    }

    Some(ConfigControl {
        id: "mode".to_owned(),
        label: "Mode".to_owned(),
        detail: None,
        purpose: ConfigPurpose::Mode,
        current: current.to_owned(),
        choices,
    })
}

/// Builds the one profile field changed by a low-level selector command.
/// Model selection is completed by `select_config`, which waits for the target
/// model and then applies the model-aware Thinking value from `controls`.
#[must_use]
pub fn selector_patch(config_id: &str, value: &str) -> Option<Value> {
    let value = non_empty(value)?;
    let field = match config_id {
        "model" => "model",
        "thinking" => "thinking",
        "mode" => "approval_mode",
        _ => return None,
    };

    Some(json!({ field: value }))
}

fn choice(value: &str, label: &str) -> ConfigChoice {
    ConfigChoice {
        value: value.to_owned(),
        label: label.to_owned(),
        detail: None,
    }
}

fn push_unique(choices: &mut Vec<ConfigChoice>, candidate: ConfigChoice) {
    if !choices
        .iter()
        .any(|choice| choice.value == candidate.value)
    {
        choices.push(candidate);
    }
}

fn contains(choices: &[ConfigChoice], value: &str) -> bool {
    choices.iter().any(|choice| choice.value == value)
}

fn non_empty(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}

fn mode_label(mode: &str) -> &str {
    match mode {
        "manual" => "Default",
        "plan" => "Plan",
        "auto" => "Auto",
        "yolo" => "YOLO",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(model: &str, thinking: &str) -> Value {
        json!({
            "model": model,
            "thinking_level": thinking,
            "approval_mode": "manual",
            "available_approval_modes": ["manual"]
        })
    }

    #[test]
    fn stale_effort_falls_back_to_declared_default() {
        let catalog = json!({ "items": [{
            "model": "deepseek",
            "capabilities": ["thinking"],
            "support_efforts": ["high", "max"],
            "default_effort": "high"
        }] });

        let thought = controls(&status("deepseek", "low"), &catalog)
            .into_iter()
            .find(|control| control.purpose == ConfigPurpose::Thought)
            .expect("Thinking control");

        assert_eq!(thought.current, "high");
        assert_eq!(
            thought
                .choices
                .iter()
                .map(|choice| choice.value.as_str())
                .collect::<Vec<_>>(),
            ["high", "max"]
        );
    }

    #[test]
    fn invalid_default_uses_middle_declared_effort() {
        let catalog = json!({ "items": [{
            "model": "target",
            "capabilities": ["thinking"],
            "support_efforts": ["low", "high", "max"],
            "default_effort": "invalid"
        }] });

        let thought = controls(&status("target", "legacy"), &catalog)
            .into_iter()
            .find(|control| control.purpose == ConfigPurpose::Thought)
            .expect("Thinking control");

        assert_eq!(thought.current, "high");
    }

    #[test]
    fn supported_effort_is_preserved() {
        let catalog = json!({ "items": [{
            "model": "target",
            "capabilities": ["thinking"],
            "support_efforts": ["high", "max"],
            "default_effort": "high"
        }] });

        let thought = controls(&status("target", "max"), &catalog)
            .into_iter()
            .find(|control| control.purpose == ConfigPurpose::Thought)
            .expect("Thinking control");

        assert_eq!(thought.current, "max");
    }

    #[test]
    fn boolean_and_unavailable_thinking_are_distinct() {
        let boolean = json!({ "items": [{
            "model": "boolean",
            "capabilities": ["thinking"]
        }] });
        let unavailable = json!({ "items": [{
            "model": "plain",
            "capabilities": []
        }] });

        let thought = controls(&status("boolean", "low"), &boolean)
            .into_iter()
            .find(|control| control.purpose == ConfigPurpose::Thought)
            .expect("boolean Thinking control");

        assert_eq!(thought.current, "on");
        assert_eq!(
            thought
                .choices
                .iter()
                .map(|choice| choice.value.as_str())
                .collect::<Vec<_>>(),
            ["on", "off"]
        );
        assert!(
            controls(&status("plain", "low"), &unavailable)
                .into_iter()
                .all(|control| control.purpose != ConfigPurpose::Thought)
        );
    }

    #[test]
    fn always_thinking_never_offers_off() {
        let catalog = json!({ "items": [{
            "model": "always",
            "capabilities": ["always_thinking"]
        }] });

        let thought = controls(&status("always", "off"), &catalog)
            .into_iter()
            .find(|control| control.purpose == ConfigPurpose::Thought)
            .expect("always-on Thinking control");

        assert_eq!(thought.current, "on");
        assert_eq!(thought.choices.len(), 1);
        assert_eq!(thought.choices[0].value, "on");
    }
}
