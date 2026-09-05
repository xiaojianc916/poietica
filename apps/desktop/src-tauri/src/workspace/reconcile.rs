//! Startup reconciliation preserves the snapshot, ledger, then filesystem order.
use crate::error::{Error, Result};
use crate::ledger::LocalIndex;
use crate::paths;
use poietica_ledger::execution::write_index;
use tauri::{AppHandle, async_runtime};
use uuid::Uuid;

pub(crate) async fn run(app: AppHandle, index: LocalIndex, boundary: Uuid) -> Result<()> {
    let snapshot = async_runtime::spawn_blocking(move || {
        paths::reset_temp_directory(&app)?;
        paths::cache_directory(&app)?;
        paths::projectless_workspaces(&app)
    })
    .await
    .map_err(|error| Error::Internal(format!("startup snapshot failed: {error}")))??;
    let needs_sweep = !snapshot.is_empty();
    let (harvested, referenced) = write_index(&index, move |store| {
        let harvested = store.harvest_ghost_threads(boundary).map_err(Error::from)?;
        let referenced = if needs_sweep {
            store.workspace_roots().map_err(Error::from)?
        } else {
            Vec::new()
        };
        Ok((harvested, referenced))
    })
    .await?;
    let swept = if needs_sweep {
        async_runtime::spawn_blocking(move || {
            paths::sweep_projectless_workspaces(snapshot, &referenced)
        })
        .await
        .map_err(|error| Error::Internal(format!("startup reclamation failed: {error}")))?
    } else {
        0
    };
    if harvested > 0 || swept > 0 {
        log::info!(
            "start-up reconciliation: harvested {harvested} ghost conversations, reclaimed {swept} projectless directories"
        );
    }
    Ok(())
}
