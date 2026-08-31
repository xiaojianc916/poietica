//! The selectors a session offers, translated from kap's own answers.
//!
//! 两张事实表按线上形状手写：status 路由的 data（sessionStatusResponseSchema）
//! 与 /models 的 data（listModelsResponseSchema），再解码成生成类型——
//! 夹具不合契约时测试当场失败。目标一格来自 goal snapshot，这里给 None ——
//! 它只影响 goal 自己的档位。

#![allow(
    clippy::expect_used,
    reason = "a test proves itself by panicking, so a failed step must fail the test"
)]

use poietica_kap_client::generated::rest::{
    CreateSessionRequestAgentConfigStruct, ListModelsDataStruct, SessionStatusDataStruct,
};
use poietica_kap_client::{ConfigControl, ConfigPurpose, controls, selector_patch};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn decode<T: DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).expect("fixture must fit the generated contract")
}

fn status(
    model: &str,
    thinking_level: &str,
    permission: &str,
    plan_mode: bool,
) -> SessionStatusDataStruct {
    decode(json!({
        "busy": false,
        "model": model,
        "thinking_level": thinking_level,
        "permission": permission,
        "plan_mode": plan_mode,
        "swarm_mode": false,
        "context_tokens": 0,
        "context_usage": 0
    }))
}

fn catalog() -> ListModelsDataStruct {
    decode(json!({
        "items": [
            { "provider": "moonshot-cn", "model": "kimi-k2.7-code-highspeed",
              "display_name": "Kimi K2.7 Code Highspeed", "max_context_size": 262_144 },
            { "provider": "moonshot-cn", "model": "kimi-k2.6",
              "display_name": "Kimi K2.6", "max_context_size": 262_144,
              "support_efforts": ["off", "on"] },
            { "provider": "moonshot-cn", "model": "kimi-k2.7-code",
              "display_name": "Kimi K2.7 Code", "max_context_size": 262_144,
              "support_efforts": ["off", "low", "high"] }
        ]
    }))
}

fn named<'a>(list: &'a [ConfigControl], id: &str) -> Option<&'a ConfigControl> {
    list.iter().find(|control| control.id == id)
}

#[test]
fn the_session_offers_its_selectors_in_order() {
    let offered = controls(
        &status("kimi-k2.6", "on", "manual", false),
        &catalog(),
        None,
    );
    let ids: Vec<&str> = offered.iter().map(|control| control.id.as_str()).collect();

    assert_eq!(
        ids,
        vec!["model", "thinking", "permission", "plan", "goal", "swarm"]
    );
}

#[test]
fn each_selector_knows_what_it_is_for() {
    let offered = controls(
        &status("kimi-k2.6", "on", "manual", false),
        &catalog(),
        None,
    );

    assert!(named(&offered, "model").is_some_and(|c| c.purpose == ConfigPurpose::Model));
    assert!(named(&offered, "permission").is_some_and(|c| c.purpose == ConfigPurpose::Permission));
    assert!(named(&offered, "plan").is_some_and(|c| c.purpose == ConfigPurpose::Mode));
    assert!(named(&offered, "thinking").is_some_and(|c| c.purpose == ConfigPurpose::Thought));
}

#[test]
fn the_values_in_force_are_carried_across() {
    let offered = controls(
        &status("kimi-k2.6", "on", "manual", false),
        &catalog(),
        None,
    );

    assert!(named(&offered, "model").is_some_and(|c| c.current == "kimi-k2.6"));
    assert!(named(&offered, "permission").is_some_and(|c| c.current == "manual"));
    assert!(named(&offered, "plan").is_some_and(|c| c.current == "off"));
    assert!(named(&offered, "thinking").is_some_and(|c| c.current == "on"));
}

#[test]
fn every_value_on_offer_is_kept() {
    let offered = controls(
        &status("kimi-k2.6", "on", "manual", false),
        &catalog(),
        None,
    );

    assert!(named(&offered, "model").is_some_and(|c| c.choices.len() == 3));
    assert!(named(&offered, "permission").is_some_and(|c| c.choices.len() == 3));
    assert!(named(&offered, "thinking").is_some_and(|c| c.choices.len() == 2));
}

#[test]
fn thinking_levels_come_from_the_current_models_own_catalog_entry() {
    let offered = controls(
        &status("kimi-k2.7-code", "low", "manual", false),
        &catalog(),
        None,
    );

    assert!(named(&offered, "thinking").is_some_and(|c| c.choices.len() == 3));
    assert!(named(&offered, "thinking").is_some_and(|c| c.current == "low"));
}

#[test]
fn a_model_without_declared_levels_has_no_thinking_selector() {
    let offered = controls(
        &status("kimi-k2.7-code-highspeed", "on", "manual", false),
        &catalog(),
        None,
    );

    assert!(named(&offered, "thinking").is_none());
}

#[test]
fn a_current_value_the_catalog_does_not_know_is_kept_verbatim() {
    let offered = controls(
        &status("some-legacy-model", "on", "manual", false),
        &catalog(),
        None,
    );
    let model = named(&offered, "model").expect("the model selector");

    assert_eq!(model.current, "some-legacy-model");
    assert!(
        model
            .choices
            .iter()
            .any(|choice| choice.value == "some-legacy-model")
    );
}

#[test]
fn plan_mode_is_its_own_rung() {
    let offered = controls(&status("kimi-k2.6", "on", "manual", true), &catalog(), None);

    assert!(named(&offered, "plan").is_some_and(|c| c.current == "on"));
}

#[test]
fn a_session_without_a_model_has_no_model_selector() {
    let offered = controls(&status("", "on", "manual", false), &catalog(), None);

    assert!(named(&offered, "model").is_none(), "不猜它此刻用什么模型");
}

#[test]
fn a_selection_becomes_the_patch_the_server_dispatch_table_expects() {
    // routes/sessionAgentConfig.ts：model → setModel，thinking → setThinking，
    // permission_mode → broadcast，plan/swarm/goal 各走自己的路由。wire 上只有
    // 被改的那一格，其余缺席不上 wire。
    let wire = |patch: CreateSessionRequestAgentConfigStruct| {
        serde_json::to_value(&patch).expect("serializable")
    };

    assert_eq!(
        wire(selector_patch("model", "kimi-k2.7-code", None).expect("model patch")),
        json!({ "model": "kimi-k2.7-code" })
    );
    assert_eq!(
        wire(selector_patch("thinking", "high", None).expect("thinking patch")),
        json!({ "thinking": "high" })
    );
    assert_eq!(
        wire(selector_patch("permission", "yolo", None).expect("permission patch")),
        json!({ "permission_mode": "yolo" })
    );
    assert_eq!(
        wire(selector_patch("plan", "on", None).expect("plan patch")),
        json!({ "plan_mode": true })
    );
    assert!(selector_patch("volume", "loud", None).is_err());
    assert!(selector_patch("model", "", None).is_err());
}
