pub(crate) mod mcp_server;

use crate::{
    error::{Error, Result},
    ledger::LocalIndex,
    paths,
};
use fs2::FileExt;
use poietica_automation::{
    AutomationCatalog, AutomationCreation, AutomationError, AutomationUpdate, Command,
    schedule::{self, SchedulePreview},
};
use poietica_automation_runtime::Runtime;
use poietica_ledger::{
    execution::{read_index, write_index},
    index::AgentStore,
};
use poietica_problem::Problem;
use poietica_time::{WallClock, wall_clock::SystemWallClock};
use serde::Serialize;
use specta::Type;
use std::fs::OpenOptions;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

#[derive(Clone, Debug, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct AutomationCatalogChanged {
    pub catalog: AutomationCatalog,
}

#[derive(Debug)]
pub(crate) struct AutomationHost {
    index: LocalIndex,
    runtime: Option<Runtime>,
    failure: Option<String>,
    accepting: AtomicBool,
}
impl AutomationHost {
    pub(crate) fn available(&self) -> Result<&Runtime> {
        if !self.accepting.load(Ordering::Acquire) {
            return Err(AutomationError::Data("自动化宿主正在关闭".to_owned()).into());
        }
        self.runtime.as_ref().ok_or_else(|| {
            AutomationError::Data(
                self.failure
                    .clone()
                    .unwrap_or_else(|| "自动化宿主不可用".to_owned()),
            )
            .into()
        })
    }
    pub(crate) fn stop(&self) -> std::io::Result<()> {
        self.accepting.store(false, Ordering::Release);
        match &self.runtime {
            Some(runtime) => runtime.stop(),
            None => Ok(()),
        }
    }
}

fn publish(app: &AppHandle, catalog: AutomationCatalog) -> bool {
    match (AutomationCatalogChanged { catalog }).emit(app) {
        Ok(()) => true,
        Err(error) => {
            log::warn!("automation catalog notification failed after commit: {error}");
            false
        }
    }
}

fn initialize(app: &AppHandle, index: &LocalIndex) -> Result<Runtime> {
    let ownership = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(paths::automation_lock(app)?)?;
    FileExt::try_lock_exclusive(&ownership)
        .map_err(|error| AutomationError::Data(format!("无法取得自动化执行权：{error}")))?;
    // Bootstrap import finishes before the scheduler and workspace reclamation start.
    let store = AgentStore::open(&paths::ledger_database(app)?, SystemWallClock)?;
    if !store.automation_initialized()? {
        let source = match std::fs::read_to_string(paths::automations_store(app)?) {
            Ok(contents) => {
                let document: serde_json::Value = serde_json::from_str(&contents)?;
                let object = document.as_object().ok_or_else(|| {
                    AutomationError::Data("automations.json 不是对象；原文件未修改".to_owned())
                })?;
                if !object.contains_key("automations") && object.contains_key("automations.corrupt")
                {
                    return Err(AutomationError::Data(
                        "检测到保留的损坏目录；拒绝以空目录覆盖，原文件未修改".to_owned(),
                    )
                    .into());
                }
                object.get("automations").cloned()
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        let zone = if source.is_some() {
            iana_time_zone::get_timezone()
                .map_err(|error| AutomationError::Data(format!("导入需要明确时区：{error}")))?
        } else {
            "UTC".to_owned()
        };
        store.import_automations(source, &zone)?;
    }
    drop(store);
    let publisher = app.clone();
    Runtime::start(
        index.clone(),
        crate::conversation::automation::AutomationExecutor::new(app.clone()),
        SystemWallClock,
        move |catalog| publish(&publisher, catalog),
        ownership,
    )
    .map_err(Error::from)
}

pub(crate) fn start(app: &AppHandle, index: LocalIndex) -> AutomationHost {
    let (runtime, failure) = match initialize(app, &index) {
        Ok(runtime) => (Some(runtime), None),
        Err(error) => {
            log::error!(
                "automation initialization failed without modifying the import source: {error}"
            );
            (None, Some(error.to_string()))
        }
    };
    AutomationHost {
        index,
        runtime,
        failure,
        accepting: AtomicBool::new(true),
    }
}

pub(crate) async fn load(app: &AppHandle) -> Result<AutomationCatalog> {
    let host = app.state::<AutomationHost>();
    host.available()?;
    read_index(&host.index, |store| {
        store.automation_catalog().map_err(Error::from)
    })
    .await
}

pub(crate) async fn execute(app: &AppHandle, command: Command) -> Result<AutomationCatalog> {
    let host = app.state::<AutomationHost>();
    let runtime = host.available()?;
    let root = match &command {
        Command::Create(creation) => Some(&creation.workspace_root),
        Command::Update(update) => Some(&update.creation.workspace_root),
        _ => None,
    };
    if let Some(root) = root {
        let metadata = tokio::fs::metadata(root)
            .await
            .map_err(|_| AutomationError::Workspace)?;
        if !metadata.is_dir() {
            return Err(AutomationError::Workspace.into());
        }
    }
    let catalog = write_index(&host.index, move |store| {
        store.automation_command(command).map_err(Error::from)
    })
    .await?;
    runtime.wake();
    publish(app, catalog.clone());
    Ok(catalog)
}

pub(crate) async fn run(
    app: &AppHandle,
    id: String,
    request_id: String,
) -> Result<AutomationCatalog> {
    let host = app.state::<AutomationHost>();
    let runtime = host.available()?;
    let agent = crate::agent::profile::default_agent_id(app)?;
    let catalog = write_index(&host.index, move |store| {
        store
            .automation_manual(&id, &request_id, &agent)
            .map_err(Error::from)
    })
    .await?;
    runtime.wake();
    publish(app, catalog.clone());
    Ok(catalog)
}

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
