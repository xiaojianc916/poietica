use crate::Runtime;
use poietica_automation::{AutomationCatalog, AutomationError, Command};
use poietica_ledger::{
    LedgerError,
    execution::{IndexError, LocalIndex, read_index, write_index},
};

pub async fn load<E>(index: &LocalIndex<E>) -> Result<AutomationCatalog, E>
where
    E: From<IndexError> + From<LedgerError> + Send + 'static,
{
    read_index(index, |store| store.automation_catalog().map_err(E::from)).await
}

pub async fn execute<E>(
    index: &LocalIndex<E>,
    runtime: &Runtime,
    command: Command,
) -> Result<AutomationCatalog, E>
where
    E: From<IndexError> + From<LedgerError> + From<AutomationError> + Send + 'static,
{
    let root = match &command {
        Command::Create(creation) => Some(&creation.workspace_root),
        Command::Update(update) => Some(&update.creation.workspace_root),
        _ => None,
    };
    if let Some(root) = root {
        let metadata = tokio::fs::metadata(root)
            .await
            .map_err(|_| E::from(AutomationError::Workspace))?;
        if !metadata.is_dir() {
            return Err(E::from(AutomationError::Workspace));
        }
    }
    let catalog = write_index(index, move |store| {
        store.automation_command(command).map_err(E::from)
    })
    .await?;
    runtime.wake();
    Ok(catalog)
}

pub async fn run<E>(
    index: &LocalIndex<E>,
    runtime: &Runtime,
    id: String,
    request_id: String,
    agent: String,
) -> Result<AutomationCatalog, E>
where
    E: From<IndexError> + From<LedgerError> + Send + 'static,
{
    let catalog = write_index(index, move |store| {
        store
            .automation_manual(&id, &request_id, &agent)
            .map_err(E::from)
    })
    .await?;
    runtime.wake();
    Ok(catalog)
}

pub async fn ensure_agent_replaceable<E>(index: &LocalIndex<E>, agent: String) -> Result<(), E>
where
    E: From<IndexError> + From<LedgerError> + From<AutomationError> + Send + 'static,
{
    let owned = read_index(index, move |store| {
        if !store.automation_initialized().map_err(E::from)? {
            return Ok(false);
        }
        Ok(store
            .automation_state()
            .map_err(E::from)?
            .executions
            .values()
            .any(|entry| entry.agent_id == agent))
    })
    .await?;
    if owned {
        return Err(E::from(AutomationError::Busy));
    }
    Ok(())
}
