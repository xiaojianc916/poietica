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
