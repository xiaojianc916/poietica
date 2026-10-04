//! 启动对账：先拍快照、后读账、最后清盘，中间态只会是「多留一份」。
use crate::error::{Error, Result};
use crate::ledger::LocalIndex;
use crate::paths;
use poietica_ledger::execution::write_index;
use uuid::Uuid;

pub(crate) async fn run(index: LocalIndex, boundary: Uuid) -> Result<()> {
    let snapshot = tokio::task::spawn_blocking(|| {
        paths::reset_temp_directory()?;
        paths::cache_directory()?;
        paths::projectless_workspaces()
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
        tokio::task::spawn_blocking(move || {
            paths::sweep_projectless_workspaces(snapshot, &referenced)
        })
        .await
        .map_err(|error| Error::Internal(format!("startup reclamation failed: {error}")))?
    } else {
        0
    };
    if harvested > 0 || swept > 0 {
        tracing::info!(
            "start-up reconciliation: harvested {harvested} ghost conversations, reclaimed {swept} projectless directories"
        );
    }
    Ok(())
}

/// 删一条对话留下的无项目工作区；「归不归我们管」的判定只有 paths 一处，这里只记失败。
pub(crate) fn remove_workspace(root: &str) {
    if let Err(error) = paths::remove_projectless_workspace(root) {
        tracing::warn!("could not remove the projectless workspace: {error}");
    }
}
