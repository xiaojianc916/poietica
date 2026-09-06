use poietica_problem::Problem;
use serde::{Deserialize, Serialize};
use specta::Type;
#[derive(Debug, Deserialize, Serialize, Type, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ThemePreference {
    Light,
    Dark,
    #[default]
    System,
}

#[derive(Debug, Deserialize, Serialize, Type, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Density {
    #[default]
    Comfortable,
    Compact,
}

// Missing fields use defaults; invalid values remain decoding errors.

#[derive(Debug, Deserialize, Serialize, Type, Clone)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct AppSettings {
    pub theme: ThemePreference,
    pub language: String,
    pub general: GeneralSettings,
    pub appearance: AppearanceSettings,
    pub model_picker: ModelPickerSettings,
    pub privacy: PrivacySettings,
}

#[derive(Debug, Deserialize, Serialize, Type, Clone)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct GeneralSettings {
    pub send_with_modifier: bool,
    pub confirm_before_delete: bool,
    pub notify_on_completion: bool,
    /// 守着本地 agent 进程的那一个意图。相位不在这里：它是进程内的事实，
    /// 落盘只会得到一份开机就过期的记载。
    pub daemon: bool,
}

#[derive(Debug, Deserialize, Serialize, Type, Clone)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct AppearanceSettings {
    pub density: Density,
    pub reduce_motion: bool,
    pub message_timestamps: bool,
}

#[derive(Debug, Deserialize, Serialize, Type, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct ModelPickerSettings {
    pub hidden_model_aliases: Vec<String>,
    pub provider_order: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize, Type, Clone)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct PrivacySettings {
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
            model_picker: ModelPickerSettings::default(),
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
            daemon: true,
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

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SettingsWriteResult {
    pub settings: AppSettings,
    pub application_problem: Option<Problem>,
}
