//! agent 自己那份设置目录：读它的 schema，写它自己的持久层。
//!
//! 目录是 agent 自报的（`label` / `description` / 类型 / 选项表 / 默认值都由它给），
//! 这一侧一格文案都不抄 —— 抄一份就是第二个事实，升级即分叉（AGENTS.md §0）。
//!
//! 写只有一条路：`Settings.set` + `flush`，由 agent 自己热重载。本层不碰它的
//! config 文件，也不预筛路径与类型 —— 预筛就是第二份路径表，认不出的由它自己拒绝。
//!
//! **钥匙那一格是信任边界**：`secret` 为真的设置只有「有没有值」过得了这条命令。
//! `crates/agent-client` 已在解码时把它的值折成 null（settings.rs 的 `from_wire`），
//! 这里的 DTO 再原样搬运一次，不往回填。

use poietica_agent_client::{SettingEntry, SettingValue, SettingsCatalog};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, State};

use super::AgentCommandResult;
use super::AgentRuntime;
use crate::agent::profile::default_agent_id;

/// 枚举/子菜单的一张选项表；原样投影。
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettingOption {
    pub value: String,
    pub label: String,
    pub description: Option<String>,
}

/// 目录里的一格设置。
///
/// **手写 Debug**：`default` 与 `value` 是设置载荷，钥匙那一格的值就在其中
/// （AGENTS.md §5「Debug 不打载荷」）。这里只打非载荷的标识。
#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettingEntry {
    pub path: String,
    /// agent 自己那份 schema 的类型词：boolean / enum / number / string / array / record。
    #[serde(rename = "type")]
    pub setting_type: String,
    pub label: String,
    pub description: String,
    /// 所在的那一栏；界面按它分组。
    pub tab: String,
    pub group: Option<String>,
    /// 未设置时生效的值。
    pub default: SettingValue,
    /// 此刻生效的值；`secret` 为真时恒为 null。
    pub value: SettingValue,
    pub secret: bool,
    pub has_value: bool,
    /// 枚举那张选项表；空即这一格没有固定选项。
    pub options: Option<Vec<AgentSettingOption>>,
    /// 没有 options 时的取值域。
    pub enum_values: Option<Vec<String>>,
    pub warning: Option<String>,
    pub condition: Option<String>,
    /// 所在分节的中文名；分组仍然按 `group`（agent 自己的词）分。
    pub group_label: Option<String>,
    /// 这一格的**行**由产品别处的控件负责；值仍然报（别的格子按它决定显不显示）。
    pub owned: bool,
}

/// 一栏：键是 agent 自己的栏目词汇（筛选认它），名是给人看的那一列。
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettingTab {
    pub key: String,
    pub label: String,
}

impl std::fmt::Debug for AgentSettingEntry {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AgentSettingEntry")
            .field("path", &self.path)
            .field("setting_type", &self.setting_type)
            .field("tab", &self.tab)
            .field("secret", &self.secret)
            .field("has_value", &self.has_value)
            /* default 与 value 刻意不在这里：它们是载荷，钥匙那一格的值就在其中。 */
            .finish_non_exhaustive()
    }
}

/// 一整份目录：有哪几栏，以及栏里的格子。
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettingsCatalog {
    /// 栏目清单，按 agent 自己的顺序；界面拿它搭导航，不另立一份。
    pub tabs: Vec<AgentSettingTab>,
    pub settings: Vec<AgentSettingEntry>,
    /// agent 此刻在用的那份配置文件（绝对路径，由它自己报）。
    pub config_file: String,
    /// 那份文件此刻在不在；不在就是还没写过。
    pub config_file_exists: bool,
}

/// 改一格设置。`value` 的类型由 agent 自己的 schema 说了算，本层不折算。
#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettingWriteRequest {
    pub path: String,
    pub value: SettingValue,
}

/// 读取 agent 自己那份设置目录；连接不存在时按统一启动管线建立。
///
/// 目录是进程级事实（与连接锚在哪个工作区无关），整份一次交回：界面自己按栏切，
/// 不为了切栏再问一遍 —— 那一问会多出一个到达时刻，两栏之间的条件求值就对不齐了。
#[tauri::command]
#[specta::specta]
pub async fn agent_settings_catalog(
    app: AppHandle,
    state: State<'_, AgentRuntime>,
) -> AgentCommandResult<AgentSettingsCatalog> {
    let catalog = state
        .settings_catalog(default_agent_id(&app)?, None)
        .await
        .map_err(crate::error::Error::from)?;

    Ok(reported_catalog(catalog))
}

/// 把 agent 自己的配置文件交给系统默认编辑器。
///
/// 路径**现问 agent**，不从前端收：交给系统 shell 的东西不能由调用方任选（同
/// `window_open_external_url` 那条纪律）。这里只开它自己报的那一个文件。
///
/// 改完不必我们替它重读：omp 自己看盘（`Settings.reloadFromDisk()`），下一次读目录
/// 就读到新的。所以这条命令不返回新目录 —— 它是「把文件交出去」，不是「提交一次改动」。
#[tauri::command]
#[specta::specta]
pub async fn agent_open_config_file(
    app: AppHandle,
    state: State<'_, AgentRuntime>,
) -> AgentCommandResult<()> {
    let catalog = state
        .settings_catalog(default_agent_id(&app)?, None)
        .await
        .map_err(crate::error::Error::from)?;

    let path = std::path::PathBuf::from(&catalog.config_file);

    if !path.is_file() {
        log::warn!("the agent has not written its config file yet");

        return Err(crate::error::Error::NotFound("agent 还没有写过配置文件".to_owned()).into());
    }

    if let Err(error) = tauri_plugin_opener::open_path(&path, None::<&str>) {
        /*
         * 开不了编辑器不是致命事：文件还在那儿，人自己能打开。但要如实报出去 ——
         * 静默失败会让人以为按钮坏了。
         */
        log::warn!("could not hand the agent config file to the system editor: {error}");

        return Err(crate::error::Error::Internal(format!("无法打开配置文件：{error}")).into());
    }

    Ok(())
}

/// 改一格设置，交回**改完之后**整份目录的 settings 那一格。
///
/// 界面拿这一份刷新自己，不做乐观改写：改没改由 agent 自己说，那是它写的盘。
#[tauri::command]
#[specta::specta]
pub async fn agent_set_setting(
    app: AppHandle,
    state: State<'_, AgentRuntime>,
    request: AgentSettingWriteRequest,
) -> AgentCommandResult<Vec<AgentSettingEntry>> {
    let entries = state
        .set_setting(default_agent_id(&app)?, request.path, request.value)
        .await
        .map_err(crate::error::Error::from)?;

    Ok(entries.into_iter().map(reported_entry).collect())
}

fn reported_catalog(catalog: SettingsCatalog) -> AgentSettingsCatalog {
    AgentSettingsCatalog {
        tabs: catalog
            .tabs
            .into_iter()
            .map(|tab| AgentSettingTab {
                key: tab.key,
                label: tab.label,
            })
            .collect(),
        settings: catalog.settings.into_iter().map(reported_entry).collect(),
        config_file: catalog.config_file,
        config_file_exists: catalog.config_file_exists,
    }
}

fn reported_entry(entry: SettingEntry) -> AgentSettingEntry {
    AgentSettingEntry {
        path: entry.path,
        setting_type: entry.setting_type,
        label: entry.label,
        description: entry.description,
        tab: entry.tab,
        group: entry.group,
        default: entry.default,
        value: entry.value,
        secret: entry.secret,
        has_value: entry.has_value,
        options: entry.options.map(|options| {
            options
                .into_iter()
                .map(|option| AgentSettingOption {
                    value: option.value,
                    label: option.label,
                    description: option.description,
                })
                .collect()
        }),
        enum_values: entry.enum_values,
        warning: entry.warning,
        condition: entry.condition,
        group_label: entry.group_label,
        owned: entry.owned,
    }
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        reason = "a test proves itself by panicking, and this fixture is known-good"
    )]

    use poietica_agent_client::SettingEntry;
    use serde_json::json;

    use super::AgentSettingEntry;

    fn entry(path: &str, secret: bool, value: serde_json::Value) -> AgentSettingEntry {
        AgentSettingEntry {
            path: path.to_owned(),
            setting_type: "string".to_owned(),
            label: "Label".to_owned(),
            description: "Description".to_owned(),
            tab: "memory".to_owned(),
            group: None,
            default: json!(null),
            value,
            secret,
            has_value: secret,
            options: None,
            enum_values: None,
            warning: None,
            condition: None,
            group_label: None,
            owned: false,
        }
    }

    /// **Debug 不打载荷。**
    ///
    /// 这个 DTO 是手写 Debug 的，理由就是它带着 `default` 与 `value` 这两格载荷。判据不能
    /// 只看代码写没写 `finish_non_exhaustive`：直接往两格里种一串明文，证明它打不出来。
    #[test]
    fn the_dto_debug_never_prints_a_payload() {
        const PLANTED: &str = "sk-planted-must-not-reach-the-log-7c3d";

        let subject = entry("mnemopi.llmApiKey", true, json!(PLANTED));

        let printed = format!("{subject:?}");

        assert!(
            !printed.contains(PLANTED),
            "Debug printed the value: {printed}"
        );
        assert!(
            !printed.contains("Description"),
            "Debug printed the description payload: {printed}"
        );
        /* 非载荷的标识照打：日志里要认得出是哪一格。 */
        assert!(printed.contains("mnemopi.llmApiKey"));
    }

    /// 这一层原样搬运 crate 交来的形状，不往回填值 —— 钥匙那一格的值在 crate 侧已经折成 null。
    #[test]
    fn a_credential_entry_stays_null_through_the_dto() {
        let wire = json!({
            "path": "hindsight.apiToken",
            "type": "string",
            "label": "Hindsight API Token",
            "description": "",
            "tab": "memory",
            "default": null,
            "value": null,
            "secret": true,
            "hasValue": true
        });

        let decoded: SettingEntry = serde_json::from_value(wire).expect("the crate shape decodes");
        let reported = super::reported_entry(decoded);

        assert!(reported.secret);
        assert!(reported.has_value);
        assert_eq!(reported.value, serde_json::Value::Null);
    }
}
