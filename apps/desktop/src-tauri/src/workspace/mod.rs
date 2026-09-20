pub mod environment;
pub(crate) mod reconcile;
pub mod storage;
pub mod table;

use tauri::{AppHandle, command};
use tauri_plugin_dialog::DialogExt;

use crate::error::Result;
use crate::paths::create_projectless_workspace;
use poietica_problem::Problem;

/// 包成自己的命令而不让渲染层直接调 dialog 插件：webview 的 IPC 面只留「选一个目录」这一条。
#[command]
#[specta::specta]
pub async fn workspace_pick_root(app: AppHandle) -> Option<String> {
    let (answer, wait) = tokio::sync::oneshot::channel();

    app.dialog().file().pick_folder(move |picked| {
        drop(answer.send(picked));
    });

    wait.await
        .inspect_err(|_| {
            log::warn!("the folder chooser went away without answering");
        })
        .ok()
        .and_then(|picked| picked.as_ref().map(ToString::to_string))
}

#[command]
#[specta::specta]
pub async fn workspace_create_projectless_root(
    app: AppHandle,
) -> std::result::Result<String, Problem> {
    (|| -> Result<String> {
        Ok(create_projectless_workspace(&app)?
            .to_string_lossy()
            .into_owned())
    })()
    .map_err(Problem::from)
}
