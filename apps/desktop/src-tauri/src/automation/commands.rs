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
pub async fn automations_load(app: AppHandle) -> std::result::Result<AutomationCatalog, Problem> {
    load(&app).await.map_err(Problem::from)
}
#[tauri::command]
#[specta::specta]
pub async fn automations_create(
    app: AppHandle,
    creation: AutomationCreation,
) -> std::result::Result<AutomationCatalog, Problem> {
    execute(&app, Command::Create(creation))
        .await
        .map_err(Problem::from)
}
#[tauri::command]
#[specta::specta]
pub async fn automations_update(
    app: AppHandle,
    update: AutomationUpdate,
) -> std::result::Result<AutomationCatalog, Problem> {
    execute(&app, Command::Update(update))
        .await
        .map_err(Problem::from)
}
#[tauri::command]
#[specta::specta]
pub async fn automations_enable(
    app: AppHandle,
    id: String,
    revision: u32,
    enabled: bool,
) -> std::result::Result<AutomationCatalog, Problem> {
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
pub async fn automations_remove(
    app: AppHandle,
    id: String,
) -> std::result::Result<AutomationCatalog, Problem> {
    execute(&app, Command::Remove { id })
        .await
        .map_err(Problem::from)
}
#[tauri::command]
#[specta::specta]
pub async fn automations_run(
    app: AppHandle,
    id: String,
    request_id: String,
) -> std::result::Result<AutomationCatalog, Problem> {
    run(&app, id, request_id).await.map_err(Problem::from)
}
#[tauri::command]
#[specta::specta]
pub async fn automations_cancel(
    app: AppHandle,
    run_id: String,
) -> std::result::Result<AutomationCatalog, Problem> {
    execute(&app, Command::Cancel { run_id })
        .await
        .map_err(Problem::from)
}
#[tauri::command]
#[specta::specta]
pub fn automations_preview(
    schedule: Option<String>,
    time_zone: String,
) -> std::result::Result<SchedulePreview, Problem> {
    Ok(schedule::preview(
        schedule.as_deref(),
        &time_zone,
        SystemWallClock.now_unix_millis(),
    ))
}
