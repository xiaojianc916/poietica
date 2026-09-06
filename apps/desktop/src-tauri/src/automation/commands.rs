use super::host::{execute, load, run};
use poietica_automation::{
    AutomationCatalog, AutomationCreation, AutomationUpdate, Command,
    schedule::{self, SchedulePreview},
};
use poietica_problem::Problem;
use poietica_time::{WallClock, wall_clock::SystemWallClock};
use tauri::AppHandle;

#[tauri::command]
#[specta::specta]
pub(crate) async fn automations_load(app: AppHandle) -> Result<AutomationCatalog, Problem> {
    load(&app).await.map_err(Problem::from)
}
#[tauri::command]
#[specta::specta]
pub(crate) async fn automations_create(
    app: AppHandle,
    creation: AutomationCreation,
) -> Result<AutomationCatalog, Problem> {
    execute(&app, Command::Create(creation))
        .await
        .map_err(Problem::from)
}
#[tauri::command]
#[specta::specta]
pub(crate) async fn automations_update(
    app: AppHandle,
    update: AutomationUpdate,
) -> Result<AutomationCatalog, Problem> {
    execute(&app, Command::Update(update))
        .await
        .map_err(Problem::from)
}
#[tauri::command]
#[specta::specta]
pub(crate) async fn automations_enable(
    app: AppHandle,
    id: String,
    revision: u32,
    enabled: bool,
) -> Result<AutomationCatalog, Problem> {
    execute(
        &app,
        Command::Enable {
            id,
            revision,
            enabled,
        },
    )
    .await
    .map_err(Problem::from)
}
#[tauri::command]
#[specta::specta]
pub(crate) async fn automations_remove(
    app: AppHandle,
    id: String,
) -> Result<AutomationCatalog, Problem> {
    execute(&app, Command::Remove { id })
        .await
        .map_err(Problem::from)
}
#[tauri::command]
#[specta::specta]
pub(crate) async fn automations_run(
    app: AppHandle,
    id: String,
    request_id: String,
) -> Result<AutomationCatalog, Problem> {
    run(&app, id, request_id).await.map_err(Problem::from)
}
#[tauri::command]
#[specta::specta]
pub(crate) async fn automations_cancel(
    app: AppHandle,
    run_id: String,
) -> Result<AutomationCatalog, Problem> {
    execute(&app, Command::Cancel { run_id })
        .await
        .map_err(Problem::from)
}
#[tauri::command]
#[specta::specta]
pub(crate) fn automations_preview(schedule: Option<String>, time_zone: String) -> SchedulePreview {
    schedule::preview(
        schedule.as_deref(),
        &time_zone,
        SystemWallClock.now_unix_millis(),
    )
}
