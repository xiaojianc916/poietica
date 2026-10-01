use super::model::{AppSettings, SettingsWriteResult};
use poietica_problem::Problem;

#[specta::specta]
pub(crate) async fn settings_get() -> Result<AppSettings, Problem> {
    crate::settings::settings()?.load()
}

#[specta::specta]
pub(crate) async fn settings_set(settings: AppSettings) -> Result<SettingsWriteResult, Problem> {
    crate::settings::settings()?.save(settings).await
}

#[specta::specta]
pub(crate) async fn settings_reset() -> Result<SettingsWriteResult, Problem> {
    crate::settings::settings()?.reset().await
}
