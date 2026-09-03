//! KAP 选择器 wire 模型到产品控制项的唯一领域投影。

use crate::error::{KapError, Result};
use crate::generated::rest::{
    CreateSessionRequestAgentConfigGoalControlEnum,
    CreateSessionRequestAgentConfigPermissionModeEnum, CreateSessionRequestAgentConfigStruct,
    ListModelsDataItemsStruct, ListModelsDataStruct, SessionGoalDataStatusEnum,
    SessionGoalDataStruct, SessionStatusDataStruct,
};

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
const PAUSE: &str = "pause";
const RESUME: &str = "resume";
const MAX_GOAL_OBJECTIVE_UTF16: usize = 4000;

#[derive(Debug)]
struct ThinkingOffer {
    current: String,
    choices: Vec<ConfigChoice>,
}

#[must_use]
pub fn controls(
    status: &SessionStatusDataStruct,
    catalog: &ListModelsDataStruct,
    goal: Option<&SessionGoalDataStruct>,
) -> Vec<ConfigControl> {
    let mut offered = Vec::new();
    let current_model = status.model.as_deref().unwrap_or("");

    if let Some(model) = model_control(current_model, &catalog.items) {
        offered.push(model);
    }
    if let Some(thinking) = thinking_control(&status.thinking_level, current_model, &catalog.items)
    {
        offered.push(thinking);
    }

    offered.push(permission_control(status));
    offered.push(toggle_control(
        "plan",
        "计划",
        "只读分析并先产出计划",
        ConfigPurpose::Mode,
        false,
        status.plan_mode,
    ));
    offered.push(goal_control(goal));
    offered.push(toggle_control(
        "swarm",
        "Swarm",
        "并行调度子代理",
        ConfigPurpose::Other,
        false,
        status.swarm_mode,
    ));
    offered
}

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
        "permission" => permission_mode_of(value).map_or_else(
            || invalid(config_id, value),
            |mode| {
                Ok(CreateSessionRequestAgentConfigStruct {
                    permission_mode: Some(mode),
                    ..Default::default()
                })
            },
        ),
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
        "goal" if value == PAUSE => Ok(CreateSessionRequestAgentConfigStruct {
            goal_control: Some(CreateSessionRequestAgentConfigGoalControlEnum::Pause),
            ..Default::default()
        }),
        "goal" if value == RESUME => Ok(CreateSessionRequestAgentConfigStruct {
            goal_control: Some(CreateSessionRequestAgentConfigGoalControlEnum::Resume),
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
        _ => invalid(config_id, value),
    }
}

fn invalid<T>(config_id: &str, value: &str) -> Result<T> {
    Err(KapError::Validation {
        message: format!("the session offers no control {config_id} with value {value}"),
    })
}

fn permission_control(status: &SessionStatusDataStruct) -> ConfigControl {
    let mut choices: Vec<ConfigChoice> = PERMISSIONS
        .iter()
        .map(|(value, label)| ConfigChoice {
            value: (*value).to_owned(),
            label: (*label).to_owned(),
            detail: None,
        })
        .collect();
    let reported = status.permission.as_str();
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoalSnapshot {
    pub objective: String,
    pub completion_criterion: Option<String>,
    pub status: String,
    pub turns_used: u64,
    pub tokens_used: u64,
    pub wall_clock_ms: u64,
}

#[must_use]
pub fn goal_snapshot(goal: Option<&SessionGoalDataStruct>) -> Option<GoalSnapshot> {
    let goal = goal.filter(|goal| !goal.objective.trim().is_empty())?;
    Some(GoalSnapshot {
        objective: goal.objective.trim().to_owned(),
        completion_criterion: goal.completion_criterion.clone(),
        status: goal_status(goal.status).to_owned(),
        turns_used: count_of(goal.turns_used),
        tokens_used: count_of(goal.tokens_used),
        wall_clock_ms: count_of(goal.wall_clock_ms),
    })
}

const fn goal_status(status: SessionGoalDataStatusEnum) -> &'static str {
    match status {
        SessionGoalDataStatusEnum::Active => "active",
        SessionGoalDataStatusEnum::Paused => "paused",
        SessionGoalDataStatusEnum::Blocked => "blocked",
        SessionGoalDataStatusEnum::Complete => "complete",
    }
}

#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "the range and integral checks make the float-to-counter conversion exact"
)]
fn count_of(value: f64) -> u64 {
    if value.is_finite()
        && value >= 0.0
        && value.fract() == 0.0
        // 上界是 2^64（u64 域外第一格）；这个十进制是它在 f64 的最短往返写法。
        && value < 18_446_744_073_709_552_000.0
    {
        value as u64
    } else {
        0
    }
}

fn goal_control(goal: Option<&SessionGoalDataStruct>) -> ConfigControl {
    let mut choices = vec![
        ConfigChoice {
            value: OFF.to_owned(),
            label: "关闭".to_owned(),
            detail: None,
        },
        ConfigChoice {
            value: ON.to_owned(),
            label: "目标".to_owned(),
            detail: Some("以当前草稿为目标持续推进".to_owned()),
        },
    ];

    if let Some(goal) = goal {
        match goal.status {
            SessionGoalDataStatusEnum::Active => choices.push(ConfigChoice {
                value: PAUSE.to_owned(),
                label: "暂停目标".to_owned(),
                detail: None,
            }),
            SessionGoalDataStatusEnum::Paused | SessionGoalDataStatusEnum::Blocked => {
                choices.push(ConfigChoice {
                    value: RESUME.to_owned(),
                    label: "恢复目标".to_owned(),
                    detail: None,
                });
            }
            SessionGoalDataStatusEnum::Complete => {}
        }
    }

    ConfigControl {
        id: "goal".to_owned(),
        label: "目标".to_owned(),
        detail: None,
        purpose: ConfigPurpose::Mode,
        applies_on_submit: true,
        current: if goal.is_some() { ON } else { OFF }.to_owned(),
        choices,
    }
}

fn model_control(current: &str, items: &[ListModelsDataItemsStruct]) -> Option<ConfigControl> {
    if current.is_empty() {
        return None;
    }
    let mut choices: Vec<ConfigChoice> = items
        .iter()
        .map(|item| ConfigChoice {
            value: item.model.clone(),
            label: item
                .display_name
                .as_deref()
                .unwrap_or(&item.model)
                .to_owned(),
            detail: None,
        })
        .collect();
    if current_not_offered(&choices, current) {
        choices.push(ConfigChoice {
            value: current.to_owned(),
            label: "模型已不可用".to_owned(),
            detail: Some(current.to_owned()),
        });
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

fn thinking_control(
    reported: &str,
    model: &str,
    items: &[ListModelsDataItemsStruct],
) -> Option<ConfigControl> {
    let offer = thinking_offer(model, non_empty(reported), items)?;
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

fn thinking_offer(
    model: &str,
    reported: Option<&str>,
    items: &[ListModelsDataItemsStruct],
) -> Option<ThinkingOffer> {
    let item = items.iter().find(|item| item.model == model)?;
    let capabilities = item.capabilities.as_deref().unwrap_or_default();
    let supports = capabilities
        .iter()
        .any(|capability| matches!(capability.as_str(), "thinking" | "always_thinking"));
    let always = capabilities
        .iter()
        .any(|capability| capability == "always_thinking");
    let mut choices = Vec::new();

    for effort in item.support_efforts.as_deref().unwrap_or_default() {
        if let Some(value) = non_empty(effort) {
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
                item.default_effort
                    .as_deref()
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
    #![allow(clippy::expect_used, reason = "failed fixtures must fail tests")]

    use serde::de::DeserializeOwned;
    use serde_json::{Value, json};

    use super::*;

    fn decode<T: DeserializeOwned>(value: Value) -> T {
        serde_json::from_value(value).expect("fixture must fit the generated contract")
    }

    fn status(model: &str, thinking: &str) -> SessionStatusDataStruct {
        decode(json!({
            "busy": false,
            "model": model,
            "thinking_level": thinking,
            "permission": "manual",
            "plan_mode": false,
            "swarm_mode": false,
            "context_tokens": 0
        }))
    }

    fn catalog(
        model: &str,
        capabilities: &Value,
        efforts: &Value,
        default_effort: &str,
    ) -> ListModelsDataStruct {
        decode(json!({ "items": [{
            "provider": "test",
            "model": model,
            "max_context_size": 1,
            "capabilities": capabilities,
            "support_efforts": efforts,
            "default_effort": default_effort
        }] }))
    }

    fn goal(objective: &str) -> SessionGoalDataStruct {
        decode(json!({
            "goalId": "goal-1",
            "objective": objective,
            "status": "active",
            "turnsUsed": 0,
            "tokensUsed": 0,
            "wallClockMs": 0,
            "budget": {
                "tokenBudget": null,
                "turnBudget": null,
                "wallClockBudgetMs": null,
                "remainingTokens": null,
                "remainingTurns": null,
                "remainingWallClockMs": null,
                "tokenBudgetReached": false,
                "turnBudgetReached": false,
                "wallClockBudgetReached": false,
                "overBudget": false
            }
        }))
    }

    #[test]
    fn orphaned_model_is_not_presented_as_its_alias() {
        let offered = catalog("provider/live", &json!([]), &json!([]), "");
        let model = controls(&status("provider/missing", "off"), &offered, None)
            .into_iter()
            .find(|control| control.purpose == ConfigPurpose::Model)
            .expect("model control");
        let orphan = model
            .choices
            .iter()
            .find(|choice| choice.value == "provider/missing")
            .expect("orphaned current model");
        assert_eq!(orphan.label, "模型已不可用");
        assert_eq!(orphan.detail.as_deref(), Some("provider/missing"));
    }

    #[test]
    fn stale_effort_falls_back_to_declared_default() {
        let offered = catalog(
            "deepseek",
            &json!(["thinking"]),
            &json!(["high", "max"]),
            "high",
        );
        let thought = controls(&status("deepseek", "low"), &offered, None)
            .into_iter()
            .find(|control| control.purpose == ConfigPurpose::Thought)
            .expect("Thinking control");
        assert_eq!(thought.current, "high");
    }

    #[test]
    fn optional_and_always_thinking_have_distinct_off_behavior() {
        let optional = catalog(
            "deepseek",
            &json!(["thinking"]),
            &json!(["low", "high", "max"]),
            "high",
        );
        let always = catalog(
            "always",
            &json!(["always_thinking"]),
            &json!(["low", "high", "max"]),
            "high",
        );
        let optional = controls(&status("deepseek", "high"), &optional, None)
            .into_iter()
            .find(|control| control.purpose == ConfigPurpose::Thought)
            .expect("optional Thinking control");
        let always = controls(&status("always", "high"), &always, None)
            .into_iter()
            .find(|control| control.purpose == ConfigPurpose::Thought)
            .expect("always Thinking control");
        let optional_pairs: Vec<_> = optional
            .choices
            .iter()
            .map(|choice| (choice.value.as_str(), choice.label.as_str()))
            .collect();
        assert_eq!(
            optional_pairs,
            vec![
                ("off", "Off"),
                ("low", "Low"),
                ("high", "High"),
                ("max", "Max")
            ]
        );
        assert!(always.choices.iter().all(|choice| choice.value != OFF));
    }

    #[test]
    fn boolean_and_unavailable_thinking_are_distinct() {
        let boolean = catalog("boolean", &json!(["thinking"]), &json!([]), "");
        let unavailable = catalog("plain", &json!([]), &json!([]), "");
        let thought = controls(&status("boolean", "low"), &boolean, None)
            .into_iter()
            .find(|control| control.purpose == ConfigPurpose::Thought)
            .expect("boolean Thinking control");
        assert_eq!(thought.current, ON);
        assert!(
            controls(&status("plain", "low"), &unavailable, None)
                .iter()
                .all(|control| control.purpose != ConfigPurpose::Thought)
        );
    }

    #[test]
    fn plan_goal_swarm_and_permission_remain_independent() {
        let status: SessionStatusDataStruct = decode(json!({
            "busy": false,
            "model": "model",
            "thinking_level": "on",
            "permission": "yolo",
            "plan_mode": true,
            "swarm_mode": true,
            "context_tokens": 0
        }));
        let catalog = catalog("model", &json!([]), &json!([]), "");
        let goal = goal("修掉 flaky 测试");
        let offered = controls(&status, &catalog, Some(&goal));
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
        assert_eq!(
            cancel.goal_control,
            Some(CreateSessionRequestAgentConfigGoalControlEnum::Cancel)
        );
        let pause = selector_patch("goal", PAUSE, None).expect("pause patch");
        assert_eq!(
            pause.goal_control,
            Some(CreateSessionRequestAgentConfigGoalControlEnum::Pause)
        );
        let resume = selector_patch("goal", RESUME, None).expect("resume patch");
        assert_eq!(
            resume.goal_control,
            Some(CreateSessionRequestAgentConfigGoalControlEnum::Resume)
        );

        let active_goal = goal("ship it");
        let active_control = goal_control(Some(&active_goal));
        assert!(
            active_control
                .choices
                .iter()
                .any(|choice| choice.value == PAUSE)
        );
        assert!(
            active_control
                .choices
                .iter()
                .all(|choice| choice.value != RESUME)
        );

        let mut paused_goal = goal("ship it");
        paused_goal.status = SessionGoalDataStatusEnum::Paused;
        let paused_control = goal_control(Some(&paused_goal));
        assert!(
            paused_control
                .choices
                .iter()
                .any(|choice| choice.value == RESUME)
        );
        assert!(
            paused_control
                .choices
                .iter()
                .all(|choice| choice.value != PAUSE)
        );
        let pause = selector_patch("goal", PAUSE, None).expect("pause patch");
        assert_eq!(
            pause.goal_control,
            Some(CreateSessionRequestAgentConfigGoalControlEnum::Pause)
        );
        let resume = selector_patch("goal", RESUME, None).expect("resume patch");
        assert_eq!(
            resume.goal_control,
            Some(CreateSessionRequestAgentConfigGoalControlEnum::Resume)
        );

        let active_goal = goal("ship it");
        let active_control = goal_control(Some(&active_goal));
        assert!(
            active_control
                .choices
                .iter()
                .any(|choice| choice.value == PAUSE)
        );
        assert!(
            active_control
                .choices
                .iter()
                .all(|choice| choice.value != RESUME)
        );

        let mut paused_goal = goal("ship it");
        paused_goal.status = SessionGoalDataStatusEnum::Paused;
        let paused_control = goal_control(Some(&paused_goal));
        assert!(
            paused_control
                .choices
                .iter()
                .any(|choice| choice.value == RESUME)
        );
        assert!(
            paused_control
                .choices
                .iter()
                .all(|choice| choice.value != PAUSE)
        );
    }
}
