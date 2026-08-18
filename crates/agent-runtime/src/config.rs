//! The configuration selectors a session offers.
//!
//! kap 没有选择器枚举：生效值由 GET /sessions/{id}/status 报（model /
//! thinking_level / permission / plan_mode），模型与思考档的候选由
//! GET /models 的目录报（support_efforts），运行模式是协议写死的三档加
//! 计划开关。这张表在这里拼出来，只此一处。
//!
//! 这里只认 JSON：kap 的线上形状就是契约（快照钉在 contracts/kap）。把协议
//! 类型引进来，等于让本 crate 依赖服务器的实现细节。

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
    ("manual", "Default", "Manual approvals; tools execute normally."),
    ("plan", "Plan", "Read-only planning; no tool execution."),
    ("auto", "Auto", "Fully autonomous - agent decides everything."),
    ("yolo", "YOLO", "Auto-approve tool actions, but it may still ask."),
];

/// Builds the selector table from the two kap answers.
///
/// status 是 status 路由的 data，catalog 是 /models 的 data。生效值永远在
/// 候选里：目录没收录的当前值按原文补进去 —— 它是这条会话此刻的真相，
/// 不能因为目录不认识就显示成别的。
#[must_use]
pub fn controls(status: &Value, catalog: &Value) -> Vec<ConfigControl> {
    let mut offered = Vec::new();

    let current_model = status["model"].as_str().unwrap_or("");
    let items = catalog["items"].as_array().map(Vec::as_slice);

    if let Some(model) = model_control(current_model, items) {
        offered.push(model);
    }

    if let Some(thinking) = thinking_control(
        status["thinking_level"].as_str().unwrap_or(""),
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
            let model = item["model"].as_str()?;

            Some(ConfigChoice {
                value: model.to_owned(),
                label: item["display_name"].as_str().unwrap_or(model).to_owned(),
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

/// 思考档的候选是当前那个模型的 support_efforts。目录没给就不出这张表：
/// 画一个拨不动的开关比不画更糟。
fn thinking_control(
    current: &str,
    model: &str,
    items: Option<&[Value]>,
) -> Option<ConfigControl> {
    if current.is_empty() {
        return None;
    }

    let efforts = items?
        .iter()
        .find(|item| item["model"].as_str() == Some(model))?["support_efforts"]
        .as_array()?;

    let mut choices: Vec<ConfigChoice> = efforts
        .iter()
        .filter_map(|effort| effort.as_str())
        .map(|effort| ConfigChoice {
            value: effort.to_owned(),
            label: effort.to_owned(),
            detail: None,
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
        id: "thinking".to_owned(),
        label: "Thinking".to_owned(),
        detail: None,
        purpose: ConfigPurpose::Thought,
        current,
        choices,
    })
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

    let permission = status["permission"].as_str().unwrap_or("");

    if current_not_offered(&choices, permission) {
        // 协议枚举之外的模式原样占一席：显示成别的才是撒谎。
        choices.push(ConfigChoice {
            value: permission.to_owned(),
            label: permission.to_owned(),
            detail: None,
        });
    }

    let reported = if status["plan_mode"].as_bool() == Some(true) {
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
