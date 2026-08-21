//! The configuration selectors a session offers.
//!
//! kap 没有选择器枚举：生效值由 GET /sessions/{id}/status 报（model /
//! thinking_level / permission / plan_mode），模型与思考档的候选由
//! GET /models 的目录报（support_efforts / default_effort / capabilities），运行模式是
//! 协议写死的三档加计划开关。这张表在这里拼出来，只此一处。
//!
//! 这里只认 JSON：kap 的线上形状就是契约（快照钉在 contracts/kap）。把协议
//! 类型引进来，等于让本 crate 依赖服务器的实现细节。
//!
//! 字段一律 .get()：Value 的索引写法在 clippy 的 indexing_slicing 下是硬错误。

use serde_json::{Value, json};

/// What a selector is for, as far as the interface is concerned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigPurpose {
    /// How much freedom the agent takes during a turn.
    Mode,
    /// Which model answers.
    Model,
    /// How long the model deliberates before answering.
    Thought,
    /// Something the agent named itself, or nothing at all.
    Other,
}

/// One value a selector will accept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigChoice {
    /// The value to send back when this one is picked.
    pub value: String,
    /// The name shown for it.
    pub label: String,
    /// The longer sentence, where there is one.
    pub detail: Option<String>,
}

/// One selector, with every value it accepts and the one in force.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigControl {
    /// The name to answer to when the value is changed.
    pub id: String,
    /// The name shown for this selector.
    pub label: String,
    /// The longer sentence, where there is one.
    pub detail: Option<String>,
    /// Where this selector belongs on screen.
    pub purpose: ConfigPurpose,
    /// The value in force right now. Always one of the offered choices.
    pub current: String,
    /// Every value on offer. Never empty.
    pub choices: Vec<ConfigChoice>,
}

/// 运行模式的四档：计划模式是 kap 的独立开关（plan_mode），其余三档就是
/// permission_mode 本身（promptPermissionModeSchema：manual / yolo / auto）。
/// 文案是界面自己的字。
const MODES: [(&str, &str, &str); 4] = [
    (
        "manual",
        "Default",
        "Manual approvals; tools execute normally.",
    ),
    ("plan", "Plan", "Read-only planning; no tool execution."),
    (
        "auto",
        "Auto",
        "Fully autonomous - agent decides everything.",
    ),
    (
        "yolo",
        "YOLO",
        "Auto-approve tool actions, but it may still ask.",
    ),
];

#[derive(Debug)]
struct ThinkingOffer {
    current: String,
    choices: Vec<ConfigChoice>,
}

/// Builds the selector table from the two kap answers.
///
/// status 是 status 路由的 data，catalog 是 /models 的 data。模型的当前值可在目录
/// 外，因为运行中的自定义模型仍是真相；Thinking 不同，它的有效域属于当前精确模型，
/// 必须在这里按目录收敛，不能把上一模型的档位补进新模型。
#[must_use]
pub fn controls(status: &Value, catalog: &Value) -> Vec<ConfigControl> {
    let mut offered = Vec::new();

    let current_model = status.get("model").and_then(Value::as_str).unwrap_or("");
    let items = catalog
        .get("items")
        .and_then(Value::as_array)
        .map(Vec::as_slice);

    if let Some(model) = model_control(current_model, items) {
        offered.push(model);
    }

    if let Some(thinking) = thinking_control(
        status
            .get("thinking_level")
            .and_then(Value::as_str)
            .unwrap_or(""),
        current_model,
        items,
    ) {
        offered.push(thinking);
    }

    offered.push(mode_control(status));

    offered
}

/// 一次选择落到 kap 的哪个 agent_config 字段。分派表在 kap-server 的
/// routes/sessionAgentConfig.ts：model → setModel，thinking → setThinking，
/// permission_mode → broadcastPermissionMode，plan_mode → plan.enter/exit。
/// 写回走 POST /sessions/{id}/profile。
#[must_use]
pub fn selector_patch(config_id: &str, value: &str) -> Option<Value> {
    match config_id {
        "model" if !value.is_empty() => Some(json!({ "model": value })),
        "thinking" if !value.is_empty() => Some(json!({ "thinking": value })),
        "mode" if value == "plan" => Some(json!({ "plan_mode": true })),
        "mode" if MODES.iter().any(|(id, ..)| *id == value) => {
            Some(json!({ "plan_mode": false, "permission_mode": value }))
        }
        _ => None,
    }
}

fn model_control(current: &str, items: Option<&[Value]>) -> Option<ConfigControl> {
    // 会话还没绑模型：不猜，猜了就是替它撒谎。
    if current.is_empty() {
        return None;
    }

    let mut choices: Vec<ConfigChoice> = items
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let model = item.get("model").and_then(Value::as_str)?;

            Some(ConfigChoice {
                value: model.to_owned(),
                label: item
                    .get("display_name")
                    .and_then(Value::as_str)
                    .unwrap_or(model)
                    .to_owned(),
                detail: None,
            })
        })
        .collect();

    if current_not_offered(&choices, current) {
        choices.push(ConfigChoice {
            value: current.to_owned(),
            label: current.to_owned(),
            detail: None,
        });
    }

    let current = in_force(&choices, current)?;

    Some(ConfigControl {
        id: "model".to_owned(),
        label: "Model".to_owned(),
        detail: None,
        purpose: ConfigPurpose::Model,
        current,
        choices,
    })
}

/// Thinking 的有效域只来自当前模型：有 efforts 就严格使用该列表；有 Thinking
/// capability 而无 efforts 时才是布尔 on/off；无 capability 时不生成可提交控件。
fn thinking_control(reported: &str, model: &str, items: Option<&[Value]>) -> Option<ConfigControl> {
    let offer = thinking_offer(model, non_empty(reported), items?)?;

    Some(ConfigControl {
        id: "thinking".to_owned(),
        label: "Thinking".to_owned(),
        detail: None,
        purpose: ConfigPurpose::Thought,
        current: offer.current,
        choices: offer.choices,
    })
}

fn thinking_offer(model: &str, reported: Option<&str>, items: &[Value]) -> Option<ThinkingOffer> {
    let item = items
        .iter()
        .find(|item| item.get("model").and_then(Value::as_str) == Some(model))?;
    let capabilities = item
        .get("capabilities")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    let supports_thinking = capabilities
        .iter()
        .any(|capability| matches!(capability.as_str(), Some("thinking" | "always_thinking")));
    let always_thinking = capabilities
        .iter()
        .any(|capability| capability.as_str() == Some("always_thinking"));
    let mut choices = Vec::new();

    if let Some(efforts) = item.get("support_efforts").and_then(Value::as_array) {
        for effort in efforts {
            let Some(value) = effort.as_str().and_then(non_empty) else {
                continue;
            };
            push_unique(&mut choices, choice(value));
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

    choices.push(choice("on"));
    if !always_thinking {
        choices.push(choice("off"));
    }

    let current = reported
        .filter(|value| contains(&choices, value))
        .unwrap_or("on")
        .to_owned();

    Some(ThinkingOffer { current, choices })
}

fn mode_control(status: &Value) -> ConfigControl {
    let mut choices: Vec<ConfigChoice> = MODES
        .iter()
        .map(|(value, label, detail)| ConfigChoice {
            value: (*value).to_owned(),
            label: (*label).to_owned(),
            detail: Some((*detail).to_owned()),
        })
        .collect();

    let permission = status
        .get("permission")
        .and_then(Value::as_str)
        .unwrap_or("");

    if current_not_offered(&choices, permission) {
        // 协议枚举之外的模式原样占一席：显示成别的才是撒谎。
        choices.push(ConfigChoice {
            value: permission.to_owned(),
            label: permission.to_owned(),
            detail: None,
        });
    }

    let reported = if status.get("plan_mode").and_then(Value::as_bool) == Some(true) {
        "plan"
    } else {
        permission
    };

    let current = in_force(&choices, reported).unwrap_or_else(|| "manual".to_owned());

    ConfigControl {
        id: "mode".to_owned(),
        label: "Mode".to_owned(),
        detail: None,
        purpose: ConfigPurpose::Mode,
        current,
        choices,
    }
}

/// 生效值必须在候选里（与 HTML select 的回落同一语义：值不在项里就落到
/// 第一项）；候选为空的选择器不成立。
fn in_force(choices: &[ConfigChoice], reported: &str) -> Option<String> {
    choices
        .iter()
        .find(|choice| choice.value == reported)
        .or_else(|| choices.first())
        .map(|choice| choice.value.clone())
}

fn current_not_offered(choices: &[ConfigChoice], current: &str) -> bool {
    !current.is_empty() && !choices.iter().any(|choice| choice.value == current)
}

fn choice(value: &str) -> ConfigChoice {
    ConfigChoice {
        value: value.to_owned(),
        label: value.to_owned(),
        detail: None,
    }
}

fn push_unique(choices: &mut Vec<ConfigChoice>, candidate: ConfigChoice) {
    if !contains(choices, &candidate.value) {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn status(model: &str, thinking: &str) -> Value {
        json!({
            "model": model,
            "thinking_level": thinking,
            "permission": "manual",
            "plan_mode": false
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
        let choice = thought
            .choices
            .get(0)
            .expect("choices must not empty for test");
        assert_eq!(choice.value, "on");
    }
}
