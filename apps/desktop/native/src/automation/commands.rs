use super::host::{execute, load, run};
use poietica_automation::{
    AutomationCatalog, AutomationCreation, AutomationUpdate, Command,
    schedule::{self, SchedulePreview},
};
use poietica_problem::Problem;
use poietica_time::{WallClock, wall_clock::SystemWallClock};

#[specta::specta]
pub async fn automations_load() -> Result<AutomationCatalog, Problem> {
    load().await.map_err(Problem::from)
}
#[specta::specta]
pub async fn automations_create(
    creation: AutomationCreation,
) -> Result<AutomationCatalog, Problem> {
    execute(Command::Create(creation))
        .await
        .map_err(Problem::from)
}
#[specta::specta]
pub async fn automations_update(update: AutomationUpdate) -> Result<AutomationCatalog, Problem> {
    execute(Command::Update(update))
        .await
        .map_err(Problem::from)
}
#[specta::specta]
pub async fn automations_enable(
    id: String,
    revision: u32,
    enabled: bool,
) -> Result<AutomationCatalog, Problem> {
    execute(Command::Enable {
        id,
        revision,
        enabled,
    })
    .await
    .map_err(Problem::from)
}
#[specta::specta]
pub async fn automations_remove(id: String) -> Result<AutomationCatalog, Problem> {
    execute(Command::Remove { id }).await.map_err(Problem::from)
}
#[specta::specta]
pub async fn automations_run(id: String, request_id: String) -> Result<AutomationCatalog, Problem> {
    run(id, request_id).await.map_err(Problem::from)
}
#[specta::specta]
pub async fn automations_cancel(run_id: String) -> Result<AutomationCatalog, Problem> {
    execute(Command::Cancel { run_id })
        .await
        .map_err(Problem::from)
}
#[specta::specta]
#[allow(
    clippy::needless_pass_by_value,
    reason = "specta 命令函数的参数由 ipc::argument 按值解出，形状必须与生成契约里的具名参数一致"
)]
pub fn automations_preview(schedule: Option<String>, time_zone: String) -> SchedulePreview {
    schedule::preview(
        schedule.as_deref(),
        &time_zone,
        SystemWallClock.now_unix_millis(),
    )
}
