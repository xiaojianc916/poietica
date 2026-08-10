use crate::error::{IpcError, Result};
use crate::paths::settings_store;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, command};
use tauri_plugin_store::StoreExt;

type SettingsCommandResult<T> = std::result::Result<T, IpcError>;

/// 颜色模式是一个闭集，不是一段自由文本。
///
/// 写成枚举，生成的 `TypeScript` 就是 `"light" | "dark" | "system"`，与 design
/// system 的 `ThemePreference` 是同一个集合，界面不必在每个调用点各自断言一次。
#[derive(Debug, Deserialize, Serialize, Type, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum ThemePreference {
    Light,
    Dark,
    #[default]
    System,
}

/// 疏密同样是闭集，理由与 `ThemePreference` 逐字相同。
#[derive(Debug, Deserialize, Serialize, Type, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Density {
    #[default]
    Comfortable,
    Compact,
}

/*
 * 线上字段名一律 camelCase。
 *
 * 这是全仓 IPC 的既有约定（agent 侧每个 DTO 都写了这一行），设置是唯一漏掉的
 * 一个：生成物是 snake_case，手写界面按约定是 camelCase，两边对不上。补这一行
 * 是修契约，而不是把界面改成 snake_case 去迁就一个漏掉的属性。
 *
 * 容器级 default 让旧盘上缺键的 settings.json 逐项退回默认值，而不是整份读取
 * 失败：用户的设置不该因为一次字段改名炸成一个错误横幅。
 *
 * theme 与 language 留在顶层，不并进 appearance：它们在第一帧之前就要被读走
 * （data-theme 缺席时令牌解成浅色），那时"设置有哪些分类"还不存在。
 */
#[derive(Debug, Deserialize, Serialize, Type, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub theme: ThemePreference,
    pub language: String,
    pub general: GeneralSettings,
    pub appearance: AppearanceSettings,
    pub privacy: PrivacySettings,
}

#[derive(Debug, Deserialize, Serialize, Type, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct GeneralSettings {
    pub send_with_modifier: bool,
    pub confirm_before_delete: bool,
    pub notify_on_completion: bool,
}

#[derive(Debug, Deserialize, Serialize, Type, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct AppearanceSettings {
    pub density: Density,
    pub reduce_motion: bool,
    pub message_timestamps: bool,
}

#[derive(Debug, Deserialize, Serialize, Type, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct PrivacySettings {
    pub telemetry: bool,
    pub crash_reporting: bool,
    pub update_check: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: ThemePreference::System,
            language: "zh-CN".into(),
            general: GeneralSettings::default(),
            appearance: AppearanceSettings::default(),
            privacy: PrivacySettings::default(),
        }
    }
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            send_with_modifier: false,
            confirm_before_delete: true,
            notify_on_completion: true,
        }
    }
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            density: Density::Comfortable,
            reduce_motion: false,
            message_timestamps: true,
        }
    }
}

impl Default for PrivacySettings {
    fn default() -> Self {
        Self {
            telemetry: false,
            crash_reporting: true,
            update_check: true,
        }
    }
}

/// Reads the persisted application settings.
///
/// # Errors
///
/// Returns an error when the settings store cannot be opened. A store that
/// opens but holds a value of an older shape is not an error: it falls back to
/// defaults so the panel stays usable.
#[command]
#[specta::specta]
pub async fn settings_get(app: AppHandle) -> SettingsCommandResult<AppSettings> {
    (|| -> Result<AppSettings> {
        let store = app.store(settings_store(&app)?)?;

        /*
         * 一份读不动的设置不是一次失败，是一次回退。
         *
         * 字段级容错由容器 default 兜住；这里兜的是整份 JSON 结构都不成立的
         * 情况（手改坏了、上个大版本的形状）。专业设置面板在这一步给默认值并
         * 让用户继续用，而不是把一个红条摆在所有开关前面。
         */
        Ok(store
            .get("settings")
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default())
    })()
    .map_err(IpcError::from)
}

/// Persists the application settings.
///
/// # Errors
///
/// Returns an error when the store cannot be opened, when the settings cannot
/// be serialized, or when the write does not reach disk.
#[command]
#[specta::specta]
pub async fn settings_set(app: AppHandle, settings: AppSettings) -> SettingsCommandResult<()> {
    (|| -> Result<()> {
        let store = app.store(settings_store(&app)?)?;
        store.set("settings", serde_json::to_value(&settings)?);
        store.save()?;
        Ok(())
    })()
    .map_err(IpcError::from)
}

/// Restores the default application settings and persists them.
///
/// # Errors
///
/// Returns an error when the store cannot be opened or the write does not
/// reach disk.
#[command]
#[specta::specta]
pub async fn settings_reset(app: AppHandle) -> SettingsCommandResult<AppSettings> {
    (|| -> Result<AppSettings> {
        let defaults = AppSettings::default();
        let store = app.store(settings_store(&app)?)?;
        store.set("settings", serde_json::to_value(&defaults)?);
        store.save()?;
        Ok(defaults)
    })()
    .map_err(IpcError::from)
}
