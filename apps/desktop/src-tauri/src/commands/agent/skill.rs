//! Kimi 当前会话提供的 Skill 目录。

use poietica_agent_runtime_native::Skill;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use super::failure::translate;
use super::runtime::{AgentRuntime, borrow};
use super::{AgentCommandResult, NO_SESSION};
use crate::error::Error;

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkill {
    pub name: String,
    pub description: String,
    pub source: String,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillsRequest {
    pub session_id: String,
}

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
