//! 技能：问 kap 要目录，请 kap 激活。
//!
//! 目录、可否激活都归 kap（routes/skills.ts）。这一侧不扫盘、不解析前言、不判
//! 能不能激活 —— 那三件事都会变成与上游分叉的第二份事实。

use poietica_agent_runtime_native::Skill;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use super::failure::translate;
use super::runtime::{AgentRuntime, borrow};
use super::{AgentCommandResult, NO_SESSION};
use crate::error::Error;

/// 一条可激活的技能。
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkill {
    pub name: String,
    pub description: String,
    /// project / user / extra / builtin，由 kap 判定。
    pub source: String,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillsRequest {
    pub session_id: String,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentActivateSkillRequest {
    pub session_id: String,
    pub name: String,
    /// 技能名后面那段自由文本；没有就是空串。
    pub args: String,
}

/// 这条会话此刻能用的技能。
///
/// # Errors
///
/// Fails when no session is live, or when kap refuses the listing.
#[tauri::command]
#[specta::specta]
pub async fn agent_skills(
    state: State<'_, AgentRuntime>,
    request: AgentSkillsRequest,
) -> AgentCommandResult<Vec<AgentSkill>> {
    let live = borrow(&state)?.ok_or_else(|| Error::NotFound(NO_SESSION.to_owned()))?;

    let listed = live
        .client
        .skills(request.session_id)
        .await
        .map_err(translate)?;

    Ok(listed
        .into_iter()
        .map(|skill: Skill| AgentSkill {
            name: skill.name,
            description: skill.description,
            source: skill.source,
        })
        .collect())
}

/// 激活一条技能。
///
/// # Errors
///
/// Fails when no session is live, or when kap refuses the activation: no such
/// skill, or a type the user may not activate.
#[tauri::command]
#[specta::specta]
pub async fn agent_activate_skill(
    state: State<'_, AgentRuntime>,
    request: AgentActivateSkillRequest,
) -> AgentCommandResult<()> {
    let live = borrow(&state)?.ok_or_else(|| Error::NotFound(NO_SESSION.to_owned()))?;

    live.client
        .activate_skill(request.session_id, request.name, request.args)
        .await
        .map_err(translate)?;

    Ok(())
}
