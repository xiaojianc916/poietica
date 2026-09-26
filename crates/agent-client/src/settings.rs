//! agent 自己那份设置目录：产品侧的词汇与读法。
//!
//! 目录是 agent 自报的（label / description / 类型 / 选项 / 默认值都由它给），本层
//! 一格都不抄 —— 抄一份就是第二个事实，升级 agent 时两份必然分叉（AGENTS.md §0）。
//! 形状来源是 packages/agent-bridge/src/protocol.ts 的 SettingEntry。
//!
//! **钥匙那一格是信任边界。** `secret` 为真的设置只有「有没有值」出得去：解码时
//! 值一律折成 null，无论线上送来了什么（见 `SettingEntry::from_wire`）。

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SettingOption {
    pub value: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// 一格设置的取值：类型由 agent 自己的 schema 说了算，本层原样搬运不折算。
///
/// 单独给个名字是给调用方用的：改设置的那条路（`AgentClient::set_setting`）要收它，
/// 而调用方那一侧不必为此自己依赖一个 JSON 库 —— 形状的产地是这一层。
pub type SettingValue = Value;

/// 目录里的一格设置。
///
/// **手写 Debug**：`default` 与 `value` 是设置载荷，钥匙那一格的值绝不出现在任何
/// Debug 输出里（AGENTS.md §5「Debug 不打载荷」）。这里只打非载荷的标识。
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingEntry {
    pub path: String,
    /// agent 自己那份 schema 的类型词：boolean / enum / number / string / array / record。
    #[serde(rename = "type")]
    pub setting_type: String,
    pub label: String,
    pub description: String,
    /// 所在的那一栏；界面按它分组。
    pub tab: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    pub default: Value,
    /// 此刻生效的值。`secret` 为真时恒为 null —— 值不出 agent 的进程。
    pub value: Value,
    pub secret: bool,
    /// 钥匙配过没有；非钥匙恒为 false。
    pub has_value: bool,
    /// 枚举那一张选项表；缺席即没有固定选项（与 `enum_values` 不同时报）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<SettingOption>>,
    /// 没有 options 时的取值域。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enum_values: Option<Vec<String>>,
    /// 风险提示（会把用户拉进限流或封号的那类设置）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    /// 可见性条件**名字**（如 `advisorEnabled`），不是判据：求值要用此刻的设置，
    /// 那是界面那一侧的事，本层原样带上（别处出现协议判别即为泄漏，AGENTS.md §5）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition: Option<String>,
    /// 所在分节的中文名。分组仍按 `group`（agent 自己的词）分：键译了同一节会分裂。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_label: Option<String>,
    /// 这一格的**行**由产品别处的控件负责；值仍然报（别的格子按它决定显不显示）。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub owned: bool,
}

impl fmt::Debug for SettingEntry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SettingEntry")
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
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsCatalog {
    /// 栏目清单，按 agent 自己的顺序。界面拿它搭导航，不另立一份。
    pub tabs: Vec<SettingsTab>,
    pub settings: Vec<SettingEntry>,
    /// agent 此刻在用的那份配置文件（绝对路径，由 agent 自己报）。
    #[serde(default)]
    pub config_file: String,
    /// 那份文件此刻在不在；不在就是还没写过。
    #[serde(default)]
    pub config_file_exists: bool,
}

/// 一栏：键是 agent 自己的栏目词汇（筛选认它），名是给人看的那一列。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsTab {
    pub key: String,
    pub label: String,
}

impl SettingEntry {
    /// 读 protocol.ts 的 SettingEntry。
    ///
    /// 缺 `path` 或认不出形状的格子如实丢掉（见 `entries_of`）：画一格读不出路径的
    /// 设置，改它就会打到别处。
    ///
    /// **钥匙那一格的值在这里截断。** 线上已经报 null，这里再折一次不是多余的：
    /// 值出不出 agent 的进程由这条边界决定，绝不能取决于对端守不守约定。
    fn from_wire(value: &Value) -> Option<Self> {
        let path = text(value, "path")?;
        let secret = flag(value, "secret");

        Some(Self {
            path,
            setting_type: text(value, "type").unwrap_or_default(),
            label: text(value, "label").unwrap_or_default(),
            description: text(value, "description").unwrap_or_default(),
            tab: text(value, "tab").unwrap_or_default(),
            group: text(value, "group"),
            default: value.get("default").cloned().unwrap_or(Value::Null),
            value: if secret {
                Value::Null
            } else {
                value.get("value").cloned().unwrap_or(Value::Null)
            },
            secret,
            has_value: flag(value, "hasValue"),
            options: options_of(value.get("options")),
            enum_values: value
                .get("enumValues")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                }),
            warning: text(value, "warning"),
            condition: text(value, "condition"),
            group_label: text(value, "groupLabel"),
            owned: flag(value, "owned"),
        })
    }
}

/// 桥报的一整份目录（`settings_catalog` 的应答）→ 产品的形状。
#[must_use]
pub(crate) fn catalog_of(data: &Value) -> SettingsCatalog {
    SettingsCatalog {
        /* 栏目顺序由 agent 给：界面拿它搭导航，不在这里另排一份。 */
        tabs: data
            .get("tabs")
            .and_then(Value::as_array)
            .map(|tabs| tabs.iter().filter_map(tab_of).collect())
            .unwrap_or_default(),
        settings: entries_of(data),
        /* 配置文件路径也由 agent 报：它知道自己在读哪个 home，我们不知道。 */
        config_file: text(data, "configFile").unwrap_or_default(),
        config_file_exists: flag(data, "configFileExists"),
    }
}

/// 桥报的一栏：键与名缺一不可（键是筛选用的那一格，名是给人的那一格）。
fn tab_of(value: &Value) -> Option<SettingsTab> {
    Some(SettingsTab {
        key: text(value, "key")?,
        /* 名可以缺着：缺了就用键，界面显示英文而不是空白。 */
        label: text(value, "label").unwrap_or_else(|| text(value, "key").unwrap_or_default()),
    })
}

/// 桥报的一栏格子（`set_setting` 的应答就是整份目录里的 settings 那一格）。
#[must_use]
pub(crate) fn entries_of(data: &Value) -> Vec<SettingEntry> {
    data.get("settings")
        .and_then(Value::as_array)
        .map(|entries| entries.iter().filter_map(SettingEntry::from_wire).collect())
        .unwrap_or_default()
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// 选项表；一张都读不下来的那张表按「没有选项」处理，不编空的。
fn options_of(value: Option<&Value>) -> Option<Vec<SettingOption>> {
    let mapped: Vec<SettingOption> = value?
        .as_array()?
        .iter()
        .filter_map(|option| {
            Some(SettingOption {
                value: text(option, "value")?,
                label: text(option, "label")?,
                description: text(option, "description"),
            })
        })
        .collect();

    if mapped.is_empty() {
        None
    } else {
        Some(mapped)
    }
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        clippy::indexing_slicing,
        reason = "a test proves itself by panicking, and these fixtures are known-good"
    )]

    use serde_json::json;

    use super::{catalog_of, entries_of};

    /// 一格普通设置：目录与值都解得开，选项表与默认值原样带上。
    #[test]
    fn a_catalog_entry_keeps_what_the_agent_reported() {
        let catalog = catalog_of(&json!({
            "tabs": [
                { "key": "appearance", "label": "外观" },
                { "key": "tools", "label": "工具" }
            ],
            "settings": [{
                "path": "browser.headless",
                "type": "boolean",
                "label": "Headless",
                "description": "Run without a window",
                "tab": "tools",
                "group": "Browser",
                "default": true,
                "value": false,
                "secret": false,
                "hasValue": false
            }]
        }));

        /* 栏是键与名成对的：键给筛选认（不译），名给人看。 */
        assert_eq!(catalog.tabs.len(), 2);
        assert_eq!(catalog.tabs[0].key, "appearance");
        assert_eq!(catalog.tabs[0].label, "外观");
        assert_eq!(catalog.settings.len(), 1);

        let entry = &catalog.settings[0];

        assert_eq!(entry.path, "browser.headless");
        assert_eq!(entry.setting_type, "boolean");
        assert_eq!(entry.tab, "tools");
        assert_eq!(entry.group.as_deref(), Some("Browser"));
        assert_eq!(entry.default, json!(true));
        assert_eq!(entry.value, json!(false));
        assert!(!entry.secret);
    }

    /// **这条是这一层的隐私边界。** 钥匙那一格的值绝不能被读进目录。
    ///
    /// 线上报 null（settings.ts 的 entryOf 把它折成 hasValue），但这条判据不能取决于
    /// 对端守不守约定：这里直接送一份**带着明文钥匙**的载荷，证明它进不了结果。
    #[test]
    fn a_credential_can_never_carry_its_value_into_the_catalog() {
        const PLANTED: &str = "sk-planted-must-not-escape-4f1a";

        let catalog = catalog_of(&json!({
            "tabs": ["memory"],
            "settings": [{
                "path": "mnemopi.embeddingApiKey",
                "type": "string",
                "label": "Embedding API Key",
                "description": "",
                "tab": "memory",
                "default": null,
                "value": PLANTED,
                "secret": true,
                "hasValue": true
            }]
        }));

        let entry = &catalog.settings[0];

        assert!(entry.secret, "这一格必须被认成钥匙");
        assert!(entry.has_value, "有没有值照旧说得出来");
        assert_eq!(
            entry.value,
            serde_json::Value::Null,
            "钥匙的值一律折成 null，无论线上送来了什么"
        );

        /* 整份目录序列化出去（IPC 契约就是它）之后也不许留下那串明文。 */
        let wire = serde_json::to_string(&catalog).expect("the catalog is serializable");

        assert!(
            !wire.contains(PLANTED),
            "the payload must not contain the credential: {wire}"
        );

        /* Debug 也不许打出来（AGENTS.md §5「Debug 不打载荷」）。 */
        assert!(!format!("{entry:?}").contains(PLANTED));
    }

    /// 选项表与取值域不同时报：有 options 就不报 enumValues，反之亦然。
    #[test]
    fn an_entry_reports_one_option_table_at_most() {
        let with_options = catalog_of(&json!({
            "settings": [{
                "path": "sleep.prevention",
                "type": "enum",
                "tab": "interaction",
                "secret": false,
                "options": [
                    { "value": "off", "label": "Off" },
                    { "value": "idle", "label": "Prevent Idle Sleep", "description": "caffeinate -i" }
                ]
            }]
        }));

        let offered = with_options.settings[0]
            .options
            .as_ref()
            .expect("an entry with options keeps them");

        assert_eq!(offered.len(), 2);
        assert_eq!(offered[1].value, "idle");
        assert_eq!(offered[1].description.as_deref(), Some("caffeinate -i"));
        assert!(with_options.settings[0].enum_values.is_none());

        let with_values = catalog_of(&json!({
            "settings": [{
                "path": "theme.dark",
                "type": "string",
                "tab": "appearance",
                "secret": false,
                "enumValues": ["a", "b"]
            }]
        }));

        assert_eq!(
            with_values.settings[0].enum_values.as_deref(),
            Some(["a".to_owned(), "b".to_owned()].as_slice())
        );
        assert!(with_values.settings[0].options.is_none());
    }

    /// 一格读不出路径的设置如实丢掉：画出来也没法改，改了还会打到别处。
    #[test]
    fn an_entry_without_a_path_is_dropped() {
        let entries = entries_of(&json!({
            "settings": [
                { "type": "boolean", "label": "无名", "tab": "tools" },
                { "path": "browser.enabled", "type": "boolean", "tab": "tools" }
            ]
        }));

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "browser.enabled");
    }

    /// `condition` 只是个**名字**：本层不解释它，也不求值（那是界面那一侧的事）。
    #[test]
    fn a_condition_is_carried_through_as_an_opaque_name() {
        let catalog = catalog_of(&json!({
            "settings": [{
                "path": "model.syncBacklog",
                "type": "number",
                "tab": "model",
                "secret": false,
                "condition": "advisorEnabled",
                "warning": "may cause rate limiting"
            }]
        }));

        assert_eq!(
            catalog.settings[0].condition.as_deref(),
            Some("advisorEnabled")
        );
        assert_eq!(
            catalog.settings[0].warning.as_deref(),
            Some("may cause rate limiting")
        );
    }
}
