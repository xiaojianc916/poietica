use super::model::{AppSettings, SettingsWriteResult};
use super::service::SettingsService;
use poietica_problem::Problem;
use tauri::{State, command};
#[command]
#[specta::specta]
pub(crate) async fn settings_get(
    service: State<'_, SettingsService>,
) -> Result<AppSettings, Problem> {
    service.load()
}
#[command]
#[specta::specta]
pub(crate) async fn settings_set(
    service: State<'_, SettingsService>,
    settings: AppSettings,
) -> Result<SettingsWriteResult, Problem> {
    service.save(settings).await
}
#[command]
#[specta::specta]
pub(crate) async fn settings_reset(
    service: State<'_, SettingsService>,
) -> Result<SettingsWriteResult, Problem> {
    service.reset().await
}
