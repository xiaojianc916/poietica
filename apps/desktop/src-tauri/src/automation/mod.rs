//! Host storage and event delivery; catalog decisions belong to poietica-automation.
pub mod mcp_server;

use crate::error::{Error, Result};
use crate::paths::automations_store;
use poietica_automation::{Automation, AutomationCatalog, AutomationCreation, AutomationRunRecord};
use poietica_problem::Problem;
use poietica_time::{WallClock, wall_clock::SystemWallClock};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, Wry, async_runtime, command};
use tauri_plugin_store::{Store, StoreExt};
use tauri_specta::Event;
use time::format_description::well_known::Rfc3339;
use tokio::time::{Instant, MissedTickBehavior, interval_at};
use uuid::Uuid;

type AutomationsCommandResult<T> = std::result::Result<T, Problem>;
const TICK: Duration = Duration::from_secs(30);

#[derive(Debug, Default)]
pub struct AutomationCatalogAccess {
    gate: Mutex<()>,
}

#[derive(Clone, Debug, Deserialize, Event, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AutomationCatalogChanged {
    pub catalog: AutomationCatalog,
}

#[derive(Clone, Debug, Deserialize, Event, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AutomationDue {
    pub automation: Automation,
}

fn open(app: &AppHandle) -> Result<Arc<Store<Wry>>> {
    Ok(app.store(automations_store(app)?)?)
}

fn read_catalog(store: &Store<Wry>) -> Result<AutomationCatalog> {
    let Some(value) = store.get("automations") else {
        return Ok(AutomationCatalog::default());
    };
    match serde_json::from_value(value.clone()) {
        Ok(catalog) => Ok(catalog),
        Err(cause) => {
            store.set("automations.corrupt", value);
            store.delete("automations");
            store.save()?;
            Err(cause.into())
        }
    }
}

pub(crate) fn load_catalog(app: &AppHandle) -> Result<AutomationCatalog> {
    let access = app.state::<AutomationCatalogAccess>();
    let _guard = access
        .gate
        .lock()
        .map_err(|_| Error::Internal("automation catalog access was poisoned".to_owned()))?;
    let store = open(app)?;
    read_catalog(&store)
}

pub(crate) fn mutate(
    app: &AppHandle,
    edit: impl FnOnce(&mut AutomationCatalog),
) -> Result<AutomationCatalog> {
    let access = app.state::<AutomationCatalogAccess>();
    let _guard = access
        .gate
        .lock()
        .map_err(|_| Error::Internal("automation catalog access was poisoned".to_owned()))?;
    let store = open(app)?;
    let mut catalog = read_catalog(&store)?;
    edit(&mut catalog);
    let serialized = serde_json::to_value(&catalog)?;
    let previous = store.get("automations");
    store.set("automations", serialized);
    if let Err(cause) = store.save() {
        match previous {
            Some(value) => store.set("automations", value),
            None => {
                store.delete("automations");
            }
        }
        return Err(cause.into());
    }
    if let Err(cause) = (AutomationCatalogChanged {
        catalog: catalog.clone(),
    })
    .emit(app)
    {
        log::warn!("could not announce the automation catalog: {cause}");
    }
    Ok(catalog)
}

pub(crate) fn create(app: &AppHandle, creation: AutomationCreation) -> Result<AutomationCatalog> {
    let created_at = SystemWallClock
        .now_utc()
        .format(&Rfc3339)
        .map_err(|cause| Error::Internal(cause.to_string()))?;
    let id = Uuid::new_v4().to_string();
    mutate(app, move |catalog| catalog.create(creation, id, created_at))
}

#[command]
#[specta::specta]
pub async fn automations_create(
    app: AppHandle,
    creation: AutomationCreation,
) -> AutomationsCommandResult<AutomationCatalog> {
    create(&app, creation).map_err(Problem::from)
}

#[command]
#[specta::specta]
pub async fn automations_load(app: AppHandle) -> AutomationsCommandResult<AutomationCatalog> {
    load_catalog(&app).map_err(Problem::from)
}

#[command]
#[specta::specta]
pub async fn automations_upsert(
    app: AppHandle,
    automation: Automation,
) -> AutomationsCommandResult<AutomationCatalog> {
    mutate(&app, move |catalog| catalog.upsert(automation)).map_err(Problem::from)
}

#[command]
#[specta::specta]
pub async fn automations_remove(
    app: AppHandle,
    id: String,
) -> AutomationsCommandResult<AutomationCatalog> {
    mutate(&app, move |catalog| catalog.remove(&id)).map_err(Problem::from)
}

#[command]
#[specta::specta]
pub async fn automations_record_run(
    app: AppHandle,
    record: AutomationRunRecord,
) -> AutomationsCommandResult<AutomationCatalog> {
    mutate(&app, move |catalog| catalog.record_run(record)).map_err(Problem::from)
}

fn ring(app: &AppHandle) -> Result<()> {
    let now = SystemWallClock.now_utc();
    for automation in load_catalog(app)?.automations {
        match automation.is_due(now) {
            Ok(false) => {}
            Ok(true) => {
                if let Err(cause) = (AutomationDue { automation }).emit(app) {
                    log::warn!("could not announce a due automation: {cause}");
                }
            }
            Err(cause) => {
                log::warn!(
                    "automation {} has an unreadable next run time: {cause}",
                    automation.id
                );
            }
        }
    }
    Ok(())
}

pub fn watch(app: &AppHandle) {
    let app = app.clone();
    async_runtime::spawn(async move {
        let mut ticks = interval_at(Instant::now() + TICK, TICK);
        ticks.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            ticks.tick().await;
            if let Err(cause) = ring(&app) {
                log::warn!("could not read the automation catalog: {cause}");
            }
        }
    });
}

#[command]
#[specta::specta]
pub async fn automations_sweep(app: AppHandle) -> AutomationsCommandResult<()> {
    ring(&app).map_err(Problem::from)
}
