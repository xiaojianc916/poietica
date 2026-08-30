//! Kimi 会话配置的唯一领域投影。
//!
//! status、model catalog 与 goal snapshot 在这里合成批准方式、计划、目标、蜂群、
//! 模型和 Thinking。独立的上游状态保持独立；UI 不再反推或复制它们。

use serde_json::Value;

use crate::error::{KapError, Result};
use crate::generated::rest::{
    CreateSessionRequestAgentConfigGoalControlEnum,
    CreateSessionRequestAgentConfigPermissionModeEnum, CreateSessionRequestAgentConfigStruct,
};

/// 界面上那三个词到 wire 上那三个词。PERMISSIONS 表管显示，这一句管上 wire。
fn permission_mode_of(value: &str) -> Option<CreateSessionRequestAgentConfigPermissionModeEnum> {
    match value {
        "manual" => Some(CreateSessionRequestAgentConfigPermissionModeEnum::Manual),
        "yolo" => Some(CreateSessionRequestAgentConfigPermissionModeEnum::Yolo),
        "auto" => Some(CreateSessionRequestAgentConfigPermissionModeEnum::Auto),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigPurpose {
    Permission,
    Mode,
    Model,
    Thought,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigChoice {
    pub value: String,
    pub label: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigControl {
    pub id: String,
    pub label: String,
    pub detail: Option<String>,
    pub purpose: ConfigPurpose,
    pub applies_on_submit: bool,
    pub current: String,
    pub choices: Vec<ConfigChoice>,
}

const PERMISSIONS: [(&str, &str); 3] = [
    ("manual", "请求批准"),
    ("yolo", "帮我批准"),
    ("auto", "完全访问权限"),
];
const OFF: &str = "off";
const ON: &str = "on";
const MAX_GOAL_OBJECTIVE_UTF16: usize = 4000;

#[derive(Debug)]
struct ThinkingOffer {
    current: String,
    choices: Vec<ConfigChoice>,
}

#[must_use]
pub fn controls(status: &Value, catalog: &Value, goal: &Value) -> Vec<ConfigControl> {
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

    offered.push(permission_control(status));
    offered.push(toggle_control(
        "plan",
        "计划",
        "只读分析并先产出计划",
        ConfigPurpose::Mode,
        false,
        status.get("plan_mode").and_then(Value::as_bool) == Some(true),
    ));
    offered.push(goal_control(goal));
    offered.push(toggle_control(
        "swarm",
        "Swarm",
        "并行调度子代理",
        ConfigPurpose::Other,
        false,
        status.get("swarm_mode").and_then(Value::as_bool) == Some(true),
    ));

    offered
}

/// 一项选择写进 profile 的那一格：类型由快照生成，只带要改的字段，其余缺席
/// 不上 wire。
pub fn selector_patch(
    config_id: &str,
    value: &str,
    input: Option<&str>,
) -> Result<CreateSessionRequestAgentConfigStruct> {
    match config_id {
        "model" if !value.is_empty() => Ok(CreateSessionRequestAgentConfigStruct {
            model: Some(value.to_owned()),
            ..Default::default()
        }),
        "thinking" if !value.is_empty() => Ok(CreateSessionRequestAgentConfigStruct {
            thinking: Some(value.to_owned()),
            ..Default::default()
        }),
        "permission" => match permission_mode_of(value) {
            Some(mode) => Ok(CreateSessionRequestAgentConfigStruct {
                permission_mode: Some(mode),
                ..Default::default()
            }),
            None => Err(KapError::Validation {
                message: format!("the session offers no control {config_id} with value {value}"),
            }),
        },
        "plan" if matches!(value, OFF | ON) => Ok(CreateSessionRequestAgentConfigStruct {
            plan_mode: Some(value == ON),
            ..Default::default()
        }),
        "swarm" if matches!(value, OFF | ON) => Ok(CreateSessionRequestAgentConfigStruct {
            swarm_mode: Some(value == ON),
            ..Default::default()
        }),
        "goal" if value == OFF => Ok(CreateSessionRequestAgentConfigStruct {
            goal_control: Some(CreateSessionRequestAgentConfigGoalControlEnum::Cancel),
            ..Default::default()
        }),
        "goal" if value == ON => {
            let objective = input.unwrap_or_default().trim();
            if objective.is_empty() {
                return Err(KapError::Validation {
                    message: "goal objective cannot be empty".to_owned(),
                });
            }
            if objective.encode_utf16().count() > MAX_GOAL_OBJECTIVE_UTF16 {
                return Err(KapError::Validation {
                    message: format!(
                        "goal objective cannot exceed {MAX_GOAL_OBJECTIVE_UTF16} UTF-16 code units"
                    ),
                });
            }
            Ok(CreateSessionRequestAgentConfigStruct {
                goal_objective: Some(objective.to_owned()),
                ..Default::default()
            })
        }
        _ => Err(KapError::Validation {
            message: format!("the session offers no control {config_id} with value {value}"),
        }),
    }
}

fn permission_control(status: &Value) -> ConfigControl {
    let mut choices: Vec<ConfigChoice> = PERMISSIONS
        .iter()
        .map(|(value, label)| ConfigChoice {
            value: (*value).to_owned(),
            label: (*label).to_owned(),
            detail: None,
        })
        .collect();
    let reported = status
        .get("permission")
        .and_then(Value::as_str)
        .unwrap_or("manual");
    if current_not_offered(&choices, reported) {
        choices.push(choice(reported));
    }

    ConfigControl {
        id: "permission".to_owned(),
        label: "批准方式".to_owned(),
        detail: None,
        purpose: ConfigPurpose::Permission,
        applies_on_submit: false,
        current: in_force(&choices, reported).unwrap_or_else(|| "manual".to_owned()),
        choices,
    }
}

fn toggle_control(
    id: &str,
    label: &str,
    detail: &str,
    purpose: ConfigPurpose,
    applies_on_submit: bool,
    enabled: bool,
) -> ConfigControl {
    ConfigControl {
        id: id.to_owned(),
        label: label.to_owned(),
        detail: None,
        purpose,
        applies_on_submit,
        current: if enabled { ON } else { OFF }.to_owned(),
        choices: vec![
            ConfigChoice {
                value: OFF.to_owned(),
                label: "关闭".to_owned(),
                detail: None,
            },
            ConfigChoice {
                value: ON.to_owned(),
                label: label.to_owned(),
                detail: Some(detail.to_owned()),
            },
        ],
    }
}

/// 目标模式此刻的全部事实，由 kap 的 `/sessions/{id}/goal` 投影而来。
///
/// 它不进 `ConfigControl`：那张表说的是「可以选什么」，而这些是「正在发生
/// 什么」。两者同寿但不同义，塞进 `detail` 会让展示字段承担领域状态。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoalSnapshot {
    pub objective: String,
    pub completion_criterion: Option<String>,
    /// active / paused / blocked / complete，按 agent 的原话。
    pub status: String,
    pub turns_used: u64,
    pub tokens_used: u64,
    /// agent 累计的运行时长；本机不另起第二个累加器。
    pub wall_clock_ms: u64,
}

/// 没有目标在跑时返回 None —— 缺席即关闭，不造一个空目标。
#[must_use]
pub fn goal_snapshot(goal: &Value) -> Option<GoalSnapshot> {
    let objective = goal
        .get("objective")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())?;

    let counter = |key: &str| goal.get(key).and_then(Value::as_u64).unwrap_or(0);

    Some(GoalSnapshot {
        objective: objective.to_owned(),
        completion_criterion: goal
            .get("completionCriterion")
            .and_then(Value::as_str)
            .map(str::to_owned),
        status: goal
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("active")
            .to_owned(),
        turns_used: counter("turnsUsed"),
        tokens_used: counter("tokensUsed"),
        wall_clock_ms: counter("wallClockMs"),
    })
}

fn goal_control(goal: &Value) -> ConfigControl {
    let objective = goal
        .get("objective")
        .and_then(Value::as_str)
        .map(str::to_owned);
    toggle_control(
        "goal",
        "目标",
        "以当前草稿为目标持续推进",
        ConfigPurpose::Mode,
        true,
        objective.is_some(),
    )
}

fn model_control(current: &str, items: Option<&[Value]>) -> Option<ConfigControl> {
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
        choices.push(choice(current));
    }
    Some(ConfigControl {
        id: "model".to_owned(),
        label: "Model".to_owned(),
        detail: None,
        purpose: ConfigPurpose::Model,
        applies_on_submit: false,
        current: in_force(&choices, current)?,
        choices,
    })
}

fn thinking_control(reported: &str, model: &str, items: Option<&[Value]>) -> Option<ConfigControl> {
    let offer = thinking_offer(model, non_empty(reported), items?)?;
    Some(ConfigControl {
        id: "thinking".to_owned(),
        label: "Thinking".to_owned(),
        detail: None,
        purpose: ConfigPurpose::Thought,
        applies_on_submit: false,
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
    let supports = capabilities
        .iter()
        .any(|capability| matches!(capability.as_str(), Some("thinking" | "always_thinking")));
    let always = capabilities
        .iter()
        .any(|capability| capability.as_str() == Some("always_thinking"));
    let mut choices = Vec::new();

    if let Some(efforts) = item.get("support_efforts").and_then(Value::as_array) {
        for effort in efforts {
            let Some(value) = effort.as_str().and_then(non_empty) else {
                continue;
            };
            push_unique(&mut choices, thinking_choice(value));
        }
    }
    if !choices.is_empty() {
        if supports && !always {
            choices.insert(0, thinking_choice(OFF));
        }
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
    if !supports {
        return None;
    }
    choices.push(thinking_choice(ON));
    if !always {
        choices.insert(0, thinking_choice(OFF));
    }
    let current = reported
        .filter(|value| contains(&choices, value))
        .unwrap_or(ON)
        .to_owned();
    Some(ThinkingOffer { current, choices })
}

fn in_force(choices: &[ConfigChoice], reported: &str) -> Option<String> {
    choices
        .iter()
        .find(|choice| choice.value == reported)
        .or_else(|| choices.first())
        .map(|choice| choice.value.clone())
}

fn current_not_offered(choices: &[ConfigChoice], current: &str) -> bool {
    !current.is_empty() && !contains(choices, current)
}

fn choice(value: &str) -> ConfigChoice {
    ConfigChoice {
        value: value.to_owned(),
        label: value.to_owned(),
        detail: None,
    }
}

fn thinking_choice(value: &str) -> ConfigChoice {
    let mut characters = value.chars();
    let label = characters.next().map_or_else(String::new, |first| {
        let mut label = first.to_uppercase().collect::<String>();
        label.push_str(characters.as_str());
        label
    });

    ConfigChoice {
        value: value.to_owned(),
        label,
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
    // 与 tests/recorder.rs 顶上那一句同一条纪律、同一个理由（Cargo.toml lints
    // 注释）：测试里的 expect 是响亮失败，豁免只写在测试作用域，不靠根配置放开。
    #![allow(
        clippy::expect_used,
        reason = "a test proves itself by panicking, so a failed step must fail the test"
    )]

    use super::*;
    use serde_json::json;

    fn status(model: &str, thinking: &str) -> Value {
        json!({
            "model": model,
            "thinking_level": thinking,
            "permission": "manual",
            "plan_mode": false,
            "swarm_mode": false
        })
    }

    fn catalog(model: &str, capabilities: &Value, efforts: &Value, default: &str) -> Value {
        json!({ "items": [{
            "model": model,
            "capabilities": capabilities,
            "support_efforts": efforts,
            "default_effort": default
        }] })
    }

    #[test]
    fn stale_effort_falls_back_to_declared_default() {
        let offered = catalog(
            "deepseek",
            &json!(["thinking"]),
            &json!(["high", "max"]),
            "high",
        );
        let thought = controls(&status("deepseek", "low"), &offered, &Value::Null)
            .into_iter()
            .find(|control| control.purpose == ConfigPurpose::Thought)
            .expect("Thinking control");
        assert_eq!(thought.current, "high");
    }

    #[test]
    fn optional_efforts_offer_off_with_display_labels() {
        let offered = catalog(
            "deepseek",
            &json!(["thinking"]),
            &json!(["low", "high", "max"]),
            "high",
        );
        let thought = controls(&status("deepseek", "high"), &offered, &Value::Null)
            .into_iter()
            .find(|control| control.purpose == ConfigPurpose::Thought)
            .expect("Thinking control");
        let values: Vec<_> = thought
            .choices
            .iter()
            .map(|choice| choice.value.as_str())
            .collect();
        let labels: Vec<_> = thought
            .choices
            .iter()
            .map(|choice| choice.label.as_str())
            .collect();

        assert_eq!(values, vec!["off", "low", "high", "max"]);
        assert_eq!(labels, vec!["Off", "Low", "High", "Max"]);
    }

    #[test]
    fn always_thinking_efforts_do_not_offer_off() {
        let offered = catalog(
            "always",
            &json!(["always_thinking"]),
            &json!(["low", "high", "max"]),
            "high",
        );
        let thought = controls(&status("always", "high"), &offered, &Value::Null)
            .into_iter()
            .find(|control| control.purpose == ConfigPurpose::Thought)
            .expect("Thinking control");

        assert!(thought.choices.iter().all(|choice| choice.value != OFF));
    }

    #[test]
    fn boolean_and_unavailable_thinking_are_distinct() {
        let boolean = json!({ "items": [{ "model": "boolean", "capabilities": ["thinking"] }] });
        let unavailable = json!({ "items": [{ "model": "plain", "capabilities": [] }] });
        let thought = controls(&status("boolean", "low"), &boolean, &Value::Null)
            .into_iter()
            .find(|control| control.purpose == ConfigPurpose::Thought)
            .expect("boolean Thinking control");
        assert_eq!(thought.current, ON);
        assert!(
            controls(&status("plain", "low"), &unavailable, &Value::Null)
                .iter()
                .all(|control| control.purpose != ConfigPurpose::Thought)
        );
    }

    #[test]
    fn plan_goal_and_swarm_remain_independent() {
        let status = json!({
            "model": "model",
            "thinking_level": "on",
            "permission": "yolo",
            "plan_mode": true,
            "swarm_mode": true
        });
        let catalog = json!({ "items": [{ "model": "model", "capabilities": [] }] });
        let goal = json!({ "objective": "修掉 flaky 测试", "status": "active" });
        let offered = controls(&status, &catalog, &goal);
        for id in ["plan", "goal", "swarm"] {
            assert_eq!(
                offered
                    .iter()
                    .find(|control| control.id == id)
                    .map(|control| control.current.as_str()),
                Some(ON)
            );
        }
        assert_eq!(
            offered
                .iter()
                .find(|control| control.id == "permission")
                .map(|control| control.current.as_str()),
            Some("yolo")
        );
    }

    #[test]
    fn goal_patch_validates_the_official_limit() {
        assert!(matches!(
            selector_patch("goal", ON, Some("  ")),
            Err(KapError::Validation { .. })
        ));
        let too_long = "😀".repeat(2001);
        assert!(matches!(
            selector_patch("goal", ON, Some(&too_long)),
            Err(KapError::Validation { .. })
        ));
        let patch = selector_patch("goal", ON, Some("  ship it  ")).expect("goal patch");
        assert_eq!(patch.goal_objective.as_deref(), Some("ship it"));
        assert_eq!(
            serde_json::to_value(&patch).expect("serializable"),
            json!({ "goal_objective": "ship it" })
        );
        let cancel = selector_patch("goal", OFF, None).expect("cancel patch");
        assert!(cancel.goal_control.is_some_and(|control| {
            control == CreateSessionRequestAgentConfigGoalControlEnum::Cancel
        }));
    }
}
