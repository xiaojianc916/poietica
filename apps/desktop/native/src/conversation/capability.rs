//! 本机能力清单。清单由 agent 自己报（桥原样转交）；安装没有 omp 对应物，如实答未接。
//!
//! 能力属于 agent 进程级服务；命令经统一运行时确保连接，不依赖某条用户对话。

use crate::agent::profile::default_agent_id;
use poietica_agent_client::{BrowserSettings, Capability, CapabilityReadiness};
use serde::{Deserialize, Serialize};
use specta::Type;

use super::AgentCommandResult;

/// agent 对一项能力的就绪裁决，原样投影。
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AgentCapabilityState {
    NotInstalled,
    Partial,
    Ready,
    Unsupported,
}

/// 后台安装进度，原样投影。
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
    /// 打开还是关上。omp 里这一项没有「安装」这一步，只有开关。
    pub enabled: bool,
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

/// 读取 agent 的应用级能力清单；连接不存在时按统一启动管线建立。
#[specta::specta]
pub async fn agent_capability_report() -> AgentCommandResult<Vec<AgentCapability>> {
    let listed = crate::conversation::runtime()?
        .capability_report(default_agent_id()?)
        .await
        .map_err(crate::error::Error::from)?;

    Ok(listed.into_iter().map(reported).collect())
}

/// 开关一项本机能力，交回改完之后的整份清单。
///
/// 与 `agent_capability_report` 同形：omp 里这一项没有安装这一步，一次开关改的是
/// 一个设置，清单里别的项也可能跟着变 —— 只回被点的那一项就是让调用方去猜。
#[specta::specta]
pub async fn agent_capability_install(
    request: AgentCapabilityInstallRequest,
) -> AgentCommandResult<Vec<AgentCapability>> {
    let installed = crate::conversation::runtime()?
        .capability_install(default_agent_id()?, request.capability_id, request.enabled)
        .await
        .map_err(crate::error::Error::from)?;

    Ok(installed.into_iter().map(reported).collect())
}

/// agent 的浏览器控制设置，原样投影。
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentBrowserSettings {
    pub enabled: bool,
    pub headless: bool,
    pub cdp_url: Option<String>,
}

/// 一次浏览器控制设置的改动；缺席的格不改。
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentBrowserSettingsPatch {
    pub enabled: Option<bool>,
    pub headless: Option<bool>,
    pub cdp_url: Option<String>,
}

fn reported_browser(settings: BrowserSettings) -> AgentBrowserSettings {
    AgentBrowserSettings {
        enabled: settings.enabled,
        headless: settings.headless,
        cdp_url: settings.cdp_url,
    }
}

/// 读取 agent 的浏览器控制设置；连接不存在时按统一启动管线建立。
#[specta::specta]
pub async fn agent_browser_settings() -> AgentCommandResult<AgentBrowserSettings> {
    let settings = crate::conversation::runtime()?
        .browser_settings(default_agent_id()?)
        .await
        .map_err(crate::error::Error::from)?;

    Ok(reported_browser(settings))
}

/// 写 agent 的浏览器控制设置；缺席的格不改，交回写完的整份。
#[specta::specta]
pub async fn agent_set_browser_settings(
    request: AgentBrowserSettingsPatch,
) -> AgentCommandResult<AgentBrowserSettings> {
    let settings = crate::conversation::runtime()?
        .set_browser_settings(
            default_agent_id()?,
            request.enabled,
            request.headless,
            request.cdp_url,
        )
        .await
        .map_err(crate::error::Error::from)?;

    Ok(reported_browser(settings))
}
