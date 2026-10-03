use crate::{
    error::{Error, Result},
    ledger::LocalIndex,
    paths,
};
use fs2::FileExt;
use poietica_automation::{AutomationCatalog, AutomationError, Command};
use poietica_automation_runtime::{Runtime, catalog};
use poietica_time::wall_clock::SystemWallClock;
use serde::Serialize;
use specta::Type;
use std::fs::OpenOptions;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Debug, Serialize, Type)]
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
    /// 停掉宿主：先拒新活，再让在跑的运行时收尾。
    pub(crate) fn shut_down(&self) -> std::io::Result<()> {
        self.accepting.store(false, Ordering::Release);
        match &self.runtime {
            Some(runtime) => runtime.stop(),
            None => Ok(()),
        }
    }
}

fn publish(catalog: AutomationCatalog) -> bool {
    match serde_json::to_value(AutomationCatalogChanged { catalog }) {
        Ok(payload) => {
            crate::transport::emit("automation_catalog_changed", &payload);
            true
        }
        Err(error) => {
            log::warn!("automation catalog notification failed after commit: {error}");
            false
        }
    }
}

fn initialize(
    index: &LocalIndex,
    conversations: crate::conversation::AgentRuntime,
) -> Result<Runtime> {
    let ownership = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(paths::automation_lock()?)?;
    FileExt::try_lock_exclusive(&ownership)
        .map_err(|error| AutomationError::Data(format!("无法取得自动化执行权：{error}")))?;
    Runtime::start(
        index.clone(),
        poietica_automation_runtime::conversation::ConversationExecutor::new(
            conversations,
            crate::agent::profile::agent_id,
        ),
        SystemWallClock,
        publish,
        ownership,
    )
    .map_err(Error::from)
}

pub(crate) fn start(
    index: LocalIndex,
    conversations: crate::conversation::AgentRuntime,
) -> AutomationHost {
    let (runtime, failure) = match initialize(&index, conversations) {
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

pub(crate) async fn load() -> Result<AutomationCatalog> {
    let host = crate::automation::automation()?;
    host.available()?;
    catalog::load(&host.index).await
}

pub(crate) async fn execute(command: Command) -> Result<AutomationCatalog> {
    let host = crate::automation::automation()?;
    let runtime = host.available()?;
    let catalog = catalog::execute(&host.index, runtime, command).await?;
    publish(catalog.clone());
    Ok(catalog)
}

pub(crate) async fn run(id: String, request_id: String) -> Result<AutomationCatalog> {
    let host = crate::automation::automation()?;
    let runtime = host.available()?;
    let agent = crate::agent::profile::agent_id()?;
    let catalog = catalog::run(&host.index, runtime, id, request_id, agent).await?;
    publish(catalog.clone());
    Ok(catalog)
}
