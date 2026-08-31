//! 本机能力的体检与安装。能力状态与安装过程均以 KAP 为唯一事实源。
//!
//! 能力属于 agent 进程级服务；命令经统一运行时确保连接，不依赖某条用户对话。

use crate::ipc::commands::cli::profile::default_agent_id;
use poietica_kap_client::{Capability, CapabilityReadiness};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, State};

use super::AgentCommandResult;
use super::dto::AgentLaunch;
use super::failure::translate;
use super::runtime::{AgentRuntime, Handle, ensure_session};

/// KAP 对一项能力的就绪裁决，原样投影。
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AgentCapabilityState {
    NotInstalled,
    Partial,
    Ready,
    Unsupported,
}

/// KAP 持有的后台安装进度，原样投影。
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilityInstall {
    pub running: bool,
    pub step: Option<String>,
    pub percent: Option<f64>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapability {
    pub id: String,
    pub plugin_id: Option<String>,
    pub label: String,
    pub supported: bool,
    pub state: AgentCapabilityState,
    pub install: AgentCapabilityInstall,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilityInstallRequest {
    pub capability_id: String,
}

fn reported(capability: Capability) -> AgentCapability {
    AgentCapability {
        id: capability.id,
        plugin_id: capability.plugin_id,
        label: capability.label,
        supported: capability.supported,
        state: match capability.state {
            CapabilityReadiness::NotInstalled => AgentCapabilityState::NotInstalled,
            CapabilityReadiness::Partial => AgentCapabilityState::Partial,
            CapabilityReadiness::Ready => AgentCapabilityState::Ready,
            CapabilityReadiness::Unsupported => AgentCapabilityState::Unsupported,
        },
        install: AgentCapabilityInstall {
            running: capability.install.running,
            step: capability.install.step,
            percent: capability.install.percent,
            error: capability.install.error,
        },
    }
}

async fn ensure_capability_host(
    app: &AppHandle,
    state: &State<'_, AgentRuntime>,
) -> crate::error::Result<Handle> {
    let agent_id = default_agent_id(app)?;

    ensure_session(app, state, AgentLaunch { agent_id }, None).await
}

/// 读取 KAP 的应用级能力清单；连接不存在时按统一启动管线建立。
#[tauri::command]
#[specta::specta]
pub async fn agent_capability_report(
    app: AppHandle,
    state: State<'_, AgentRuntime>,
) -> AgentCommandResult<Vec<AgentCapability>> {
    let live = ensure_capability_host(&app, &state).await?;
    let listed = live.client.capabilities().await.map_err(translate)?;

    Ok(listed.into_iter().map(reported).collect())
}

/// 启动或跟随 KAP 的幂等安装，连接不存在时先按统一管线建立。
#[tauri::command]
#[specta::specta]
pub async fn agent_capability_install(
    app: AppHandle,
    state: State<'_, AgentRuntime>,
    request: AgentCapabilityInstallRequest,
) -> AgentCommandResult<AgentCapability> {
    let live = ensure_capability_host(&app, &state).await?;
    let installed = live
        .client
        .install_capability(request.capability_id)
        .await
        .map_err(translate)?;

    Ok(reported(installed))
}
