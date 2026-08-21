export function migrateSessionProfile(m) {
  const config = 'crates/agent-runtime/src/config.rs'
  m.replace(
    config,
    `pub enum ConfigPurpose {\n    /// How much freedom the agent takes during a turn.\n    Mode,`,
    `pub enum ConfigPurpose {\n    /// Which permission policy governs tool execution.\n    Permission,\n    /// An independent session feature toggle.\n    Mode,`,
  )
  m.section(
    config,
    `/// 运行模式的四档：`,
    `#[derive(Debug)]\nstruct ThinkingOffer`,
    `const PERMISSIONS: [(&str, &str, &str); 3] = [\n    (\"manual\", \"请求批准\", \"编辑外部资源前请求批准。\"),\n    (\"yolo\", \"帮我批准\", \"自动批准工具动作，但仍可提问。\"),\n    (\"auto\", \"完全访问\", \"自动批准工具动作与问题。\"),\n];\n\nconst TOGGLES: [(&str, &str); 2] = [(\"off\", \"关闭\"), (\"on\", \"开启\")];\n\n#[derive(Debug)]\nstruct ThinkingOffer`,
    `const PERMISSIONS: [(&str, &str, &str); 3]`,
  )
  m.replace(
    config,
    `    offered.push(mode_control(status));\n\n    offered`,
    `    offered.push(permission_control(status));\n    offered.push(toggle_control(\"plan\", \"计划\", bool_of(status, \"plan_mode\")));\n    offered.push(toggle_control(\"swarm\", \"蜂群\", bool_of(status, \"swarm_mode\")));\n\n    if let Some(enabled) = status.get(\"tower_mode\").and_then(Value::as_bool) {\n        offered.push(toggle_control(\"tower\", \"Tower\", enabled));\n    }\n\n    offered`,
  )
  m.section(
    config,
    `pub fn selector_patch(config_id: &str, value: &str) -> Option<Value> {`,
    `fn model_control(`,
    `pub fn selector_patch(config_id: &str, value: &str) -> Option<Value> {\n    match config_id {\n        \"model\" if !value.is_empty() => Some(json!({ \"model\": value })),\n        \"thinking\" if !value.is_empty() => Some(json!({ \"thinking\": value })),\n        \"permission\" if PERMISSIONS.iter().any(|(id, ..)| *id == value) => {\n            Some(json!({ \"permission_mode\": value }))\n        }\n        \"plan\" => toggle_patch(\"plan_mode\", value),\n        \"swarm\" => toggle_patch(\"swarm_mode\", value),\n        \"tower\" => toggle_patch(\"tower_mode\", value),\n        _ => None,\n    }\n}\n\nfn toggle_patch(field: &str, value: &str) -> Option<Value> {\n    let enabled = match value {\n        \"on\" => true,\n        \"off\" => false,\n        _ => return None,\n    };\n    let mut patch = serde_json::Map::new();\n    patch.insert(field.to_owned(), Value::Bool(enabled));\n    Some(Value::Object(patch))\n}\n\nfn model_control(`,
    `\"permission\" if PERMISSIONS.iter().any`,
  )
  m.section(
    config,
    `fn mode_control(status: &Value) -> ConfigControl {`,
    `/// 生效值必须在候选里`,
    `fn permission_control(status: &Value) -> ConfigControl {\n    let mut choices: Vec<ConfigChoice> = PERMISSIONS\n        .iter()\n        .map(|(value, label, detail)| ConfigChoice {\n            value: (*value).to_owned(),\n            label: (*label).to_owned(),\n            detail: Some((*detail).to_owned()),\n        })\n        .collect();\n    let reported = status.get(\"permission\").and_then(Value::as_str).unwrap_or(\"manual\");\n    if current_not_offered(&choices, reported) {\n        choices.push(ConfigChoice { value: reported.to_owned(), label: reported.to_owned(), detail: None });\n    }\n    ConfigControl {\n        id: \"permission\".to_owned(),\n        label: \"权限\".to_owned(),\n        detail: None,\n        purpose: ConfigPurpose::Permission,\n        current: in_force(&choices, reported).unwrap_or_else(|| \"manual\".to_owned()),\n        choices,\n    }\n}\n\nfn toggle_control(id: &str, label: &str, enabled: bool) -> ConfigControl {\n    ConfigControl {\n        id: id.to_owned(),\n        label: label.to_owned(),\n        detail: None,\n        purpose: ConfigPurpose::Mode,\n        current: if enabled { \"on\" } else { \"off\" }.to_owned(),\n        choices: TOGGLES.iter().map(|(value, label)| ConfigChoice {\n            value: (*value).to_owned(),\n            label: (*label).to_owned(),\n            detail: None,\n        }).collect(),\n    }\n}\n\nfn bool_of(status: &Value, field: &str) -> bool {\n    status.get(field).and_then(Value::as_bool).unwrap_or(false)\n}\n\n/// 生效值必须在候选里`,
    `fn permission_control(status: &Value) -> ConfigControl`,
  )

  m.replace(
    'apps/desktop/src-tauri/src/commands/agent/dto.rs',
    `pub enum AgentConfigPurpose {\n    /// How much freedom the agent takes during a turn.\n    Mode,`,
    `pub enum AgentConfigPurpose {\n    /// Which permission policy governs tool execution.\n    Permission,\n    /// An independent session feature toggle.\n    Mode,`,
  )
  m.replace(
    'apps/desktop/src-tauri/src/commands/agent/config.rs',
    `        purpose: match control.purpose {\n            ConfigPurpose::Mode => AgentConfigPurpose::Mode,`,
    `        purpose: match control.purpose {\n            ConfigPurpose::Permission => AgentConfigPurpose::Permission,\n            ConfigPurpose::Mode => AgentConfigPurpose::Mode,`,
  )
  m.replace(
    'packages/agent-contract/src/config.ts',
    `export type SessionConfigPurpose = 'model' | 'thought' | 'mode' | 'other'`,
    `export type SessionConfigPurpose = 'model' | 'thought' | 'permission' | 'mode' | 'other'`,
  )
  m.replace(
    'packages/agent/src/session/permission-posture.ts',
    `return controls.find((control) => control.purpose === 'mode')`,
    `return controls.find((control) => control.purpose === 'permission')`,
  )
  m.replace(
    'packages/agent/src/session/agent-capability-store.ts',
    `if (control.purpose === 'mode') {`,
    `if (control.purpose === 'permission') {`,
  )
  m.replace(
    'packages/agent/src/session/session-controls-store.ts',
    `if (control?.purpose === 'mode') {`,
    `if (control?.purpose === 'permission') {`,
  )

  const test = `//! Session profile fields are independent; no selector may hide another.\n\nuse poietica_agent_runtime_native::{ConfigPurpose, controls, selector_patch};\nuse serde_json::{Value, json};\n\nfn status(plan: bool, swarm: bool, tower: bool) -> Value {\n    json!({\n        \"busy\": false, \"model\": \"kimi\", \"thinking_level\": \"on\",\n        \"permission\": \"manual\", \"plan_mode\": plan,\n        \"swarm_mode\": swarm, \"tower_mode\": tower, \"context_tokens\": 0\n    })\n}\n\nfn catalog() -> Value {\n    json!({ \"items\": [{ \"model\": \"kimi\", \"display_name\": \"Kimi\", \"capabilities\": [\"thinking\"] }] })\n}\n\n#[test]\nfn independent_profile_fields_are_simultaneously_visible() {\n    let offered = controls(&status(true, true, true), &catalog());\n    let ids: Vec<&str> = offered.iter().map(|item| item.id.as_str()).collect();\n    assert_eq!(ids, [\"model\", \"thinking\", \"permission\", \"plan\", \"swarm\", \"tower\"]);\n    assert!(offered.iter().find(|item| item.id == \"permission\").is_some_and(|item| item.purpose == ConfigPurpose::Permission));\n    for id in [\"plan\", \"swarm\", \"tower\"] {\n        assert!(offered.iter().find(|item| item.id == id).is_some_and(|item| item.purpose == ConfigPurpose::Mode && item.current == \"on\"));\n    }\n}\n\n#[test]\nfn selectors_patch_one_official_profile_field() {\n    assert_eq!(selector_patch(\"permission\", \"yolo\"), Some(json!({ \"permission_mode\": \"yolo\" })));\n    assert_eq!(selector_patch(\"plan\", \"on\"), Some(json!({ \"plan_mode\": true })));\n    assert_eq!(selector_patch(\"swarm\", \"on\"), Some(json!({ \"swarm_mode\": true })));\n    assert_eq!(selector_patch(\"tower\", \"off\"), Some(json!({ \"tower_mode\": false })));\n    assert_eq!(selector_patch(\"plan\", \"maybe\"), None);\n}\n`
  m.write('crates/agent-runtime/tests/config.rs', test, 'fn the_session_offers_three_selectors')
}
