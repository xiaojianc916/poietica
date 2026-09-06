use crate::{
    error::{Error, Result},
    ledger::LocalIndex,
    paths,
};
use fs2::FileExt;
use poietica_automation::{AutomationCatalog, AutomationError, Command};
use poietica_automation_runtime::{Runtime, catalog};
use poietica_ledger::execution::write_index_worker;
use poietica_time::wall_clock::SystemWallClock;
use serde::Serialize;
use specta::Type;
use std::fs::OpenOptions;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

#[derive(Clone, Debug, Serialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomationCatalogChanged {
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

fn initialize(
    app: &AppHandle,
    index: &LocalIndex,
    conversations: crate::conversation::AgentRuntime,
) -> Result<Runtime> {
    let ownership = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(paths::automation_lock(app)?)?;
    FileExt::try_lock_exclusive(&ownership)
        .map_err(|error| AutomationError::Data(format!("无法取得自动化执行权：{error}")))?;
    // Bootstrap import finishes before the scheduler and workspace reclamation start.
    let initialized = write_index_worker(index, |store| {
        store.automation_initialized().map_err(Error::from)
    })?;
    if !initialized {
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
        write_index_worker(index, move |store| {
            store.import_automations(source, &zone).map_err(Error::from)
        })?;
    }
    let publisher = app.clone();
    let profiles = app.clone();
    Runtime::start(
        index.clone(),
        poietica_automation_runtime::conversation::ConversationExecutor::new(
            conversations,
            move || crate::agent::profile::default_agent_id(&profiles),
        ),
        SystemWallClock,
        move |catalog| publish(&publisher, catalog),
        ownership,
    )
    .map_err(Error::from)
}

pub(crate) fn start(
    app: &AppHandle,
    index: LocalIndex,
    conversations: crate::conversation::AgentRuntime,
) -> AutomationHost {
    let (runtime, failure) = match initialize(app, &index, conversations) {
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
    catalog::load(&host.index).await
}

pub(crate) async fn execute(app: &AppHandle, command: Command) -> Result<AutomationCatalog> {
    let host = app.state::<AutomationHost>();
    let runtime = host.available()?;
    let catalog = catalog::execute(&host.index, runtime, command).await?;
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
    let catalog = catalog::run(&host.index, runtime, id, request_id, agent).await?;
    publish(app, catalog.clone());
    Ok(catalog)
}
