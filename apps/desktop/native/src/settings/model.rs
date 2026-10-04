use poietica_problem::Problem;
use serde::{Deserialize, Serialize};
use specta::Type;
#[derive(Debug, Deserialize, Serialize, Type, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum ThemePreference {
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

/// 日志闸门：这个级别**及以上**才落盘。默认 warn。
///
/// 档位与 tracing 的级别同名，所以转 EnvFilter 是直译，没有第二张映射表。
/// 不设 trace：全仓没有一处 trace 事件，留一格永远收不到东西的选项是假选择。
#[derive(Debug, Deserialize, Serialize, Type, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LogLevel {
    Error,
    #[default]
    Warn,
    Info,
    Debug,
}

impl LogLevel {
    /// 给 EnvFilter 的档位名。这是它与 tracing 级别名同名的唯一用处。
    pub(crate) fn as_filter(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warn => "warn",
            Self::Info => "info",
            Self::Debug => "debug",
        }
    }
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
    pub logging: LoggingSettings,
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

#[derive(Debug, Deserialize, Serialize, Type, Clone)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct LoggingSettings {
    pub level: LogLevel,
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
            logging: LoggingSettings::default(),
        }
    }
}

impl Default for LoggingSettings {
    fn default() -> Self {
        Self {
            level: LogLevel::Warn,
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

#[cfg(test)]
#[allow(clippy::expect_used, reason = "测试作用域：断言必须当场炸")]
mod tests {
    use super::{AppSettings, LogLevel};

    #[test]
    fn the_log_gateway_defaults_to_warn() {
        assert_eq!(AppSettings::default().logging.level, LogLevel::Warn);
    }

    /// 缺这一格的老文档要落到默认值上，而不是解码失败 —— 整份设置会跟着一起读不出来。
    #[test]
    fn a_document_without_the_logging_section_still_decodes() {
        let settings: AppSettings =
            serde_json::from_str("{}").expect("missing fields use defaults");

        assert_eq!(settings.logging.level, LogLevel::Warn);
    }

    #[test]
    fn every_level_maps_to_its_tracing_name() {
        assert_eq!(LogLevel::Error.as_filter(), "error");
        assert_eq!(LogLevel::Warn.as_filter(), "warn");
        assert_eq!(LogLevel::Info.as_filter(), "info");
        assert_eq!(LogLevel::Debug.as_filter(), "debug");
    }
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SettingsWriteResult {
    pub settings: AppSettings,
    pub application_problem: Option<Problem>,
}
