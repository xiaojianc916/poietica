pub(crate) mod commands;
mod model;
mod repository;
mod service;
mod storage;
pub(crate) use model::SettingsWriteResult;
pub use model::ThemePreference;
pub(crate) use model::{AppSettings, PrivacySettings};
pub(crate) use service::SettingsService;
pub(crate) use storage::FileSettingsRepository;

use std::sync::{Arc, OnceLock};

use crate::error::{Error, Result};

/// 设置服务是进程级的：持久化文件只有一个写者。
static SETTINGS: OnceLock<Arc<SettingsService>> = OnceLock::new();

pub(crate) fn open_settings(service: Arc<SettingsService>) -> Result<()> {
    SETTINGS
        .set(service)
        .map_err(|_| Error::Internal("the settings service was already opened".to_owned()))
}

pub(crate) fn settings() -> Result<Arc<SettingsService>> {
    SETTINGS
        .get()
        .cloned()
        .ok_or_else(|| Error::Internal("the settings service is not up".to_owned()))
}

/// 日志闸门的档位，从设置文档里读。
///
/// 只有 `bootstrap` 在设置服务建起来**之前**用它 —— 那一步要用它决定第一条日志收不收。
/// 之后一律走 `SettingsService`（它是设置的唯一读写面）。读不到、解析不了都是默认 warn：
/// 一份还没有或已经坏掉的设置文档不比「按默认来」有更多信息。
pub(crate) fn read_log_level(path: &std::path::Path) -> String {
    let level = std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|document| {
            serde_json::from_value::<AppSettings>(document.get(storage::SETTINGS_KEY)?.clone()).ok()
        })
        .unwrap_or_default()
        .logging
        .level;

    level.as_filter().to_owned()
}

#[cfg(test)]
#[allow(clippy::expect_used, reason = "测试作用域：断言必须当场炸")]
mod log_level_tests {
    use super::read_log_level;

    fn written(document: &str) -> String {
        let directory = tempfile::tempdir().expect("test directory");
        let path = directory.path().join("settings.json");

        std::fs::write(&path, document).expect("test file");

        read_log_level(&path)
    }

    #[test]
    fn a_missing_document_is_the_default() {
        let directory = tempfile::tempdir().expect("test directory");

        assert_eq!(
            read_log_level(&directory.path().join("absent.json")),
            "warn"
        );
    }

    #[test]
    fn the_stored_level_is_read() {
        assert_eq!(
            written(r#"{"settings":{"logging":{"level":"debug"}}}"#),
            "debug"
        );
    }

    /// 坏文档不是启动失败：退回默认值，应用照常起来。
    #[test]
    fn a_corrupt_document_falls_back_to_the_default() {
        assert_eq!(written("{broken"), "warn");
        assert_eq!(
            written(r#"{"settings":{"logging":{"level":"nonsense"}}}"#),
            "warn"
        );
    }
}
