//! 本机能力的体检与安装：真相在本机 kap，这一层只投影。
//!
//! 只读已在的连接。设置页不该顺手起一个 agent 进程 —— ensure_session 复用连接时
//! 不比工作目录，从这里起的那一条会把整条连接钉在 home 上。

use crate::error::Error;
use poietica_kap_client::Capability;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use super::AgentCommandResult;
use super::failure::translate;
use super::runtime::{AgentRuntime, borrow};
use super::NO_SESSION;

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilityStep {
    pub id: String,
    pub label: String,
    /// kap 报的这一步状态原文。
    pub state: String,
    pub satisfied: bool,
}

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapability {
    pub id: String,
    pub label: String,
    pub supported: bool,
    pub steps: Vec<AgentCapabilityStep>,
}

/// 「没连上」与「连上了，它这么说」不是一件事，所以判别式在类型里。
#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum AgentCapabilityReport {
    Unreachable,
    Reported { capabilities: Vec<AgentCapability> },
}

#[derive(Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilityInstallRequest {
    pub capability_id: String,
}

fn reported(capability: Capability) -> AgentCapability {
    AgentCapability {
        id: capability.id,
        label: capability.label,
        supported: capability.supported,
        steps: capability
            .steps
            .into_iter()
            .map(|step| AgentCapabilityStep {
                id: step.id,
                label: step.label,
                state: step.state,
                satisfied: step.satisfied,
            })
            .collect(),
    }
}

/// 本机 kap 此刻报的能力清单。
///
/// # Errors
///
/// kap 拒绝或链路故障时失败。没有连接不是失败：那一刻没有人能回答。
#[tauri::command]
#[specta::specta]
pub async fn agent_capability_report(
    state: State<'_, AgentRuntime>,
) -> AgentCommandResult<AgentCapabilityReport> {
    let Some(live) = borrow(&state)? else {
        return Ok(AgentCapabilityReport::Unreachable);
    };

    let listed = live.client.capabilities().await.map_err(translate)?;

    Ok(AgentCapabilityReport::Reported {
        capabilities: listed.into_iter().map(reported).collect(),
    })
}

/// 让本机 kap 装一项能力。幂等，交回它此刻的进度。
///
/// # Errors
///
/// 没有连接、kap 拒绝，或它装完仍不报这项能力时失败。
#[tauri::command]
#[specta::specta]
pub async fn agent_capability_install(
    state: State<'_, AgentRuntime>,
    request: AgentCapabilityInstallRequest,
) -> AgentCommandResult<AgentCapability> {
    let live = borrow(&state)?.ok_or_else(|| Error::NotFound(NO_SESSION.to_owned()))?;

    let installed = live
        .client
        .install_capability(request.capability_id)
        .await
        .map_err(translate)?;

    Ok(reported(installed))
}
