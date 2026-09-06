use super::{AgentCommandResult, dto::AgentExportThreadRequest, runtime::AgentRuntime};
use crate::error::Error;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
#[specta::specta]
pub async fn agent_export_thread(
    app: AppHandle,
    state: State<'_, AgentRuntime>,
    request: AgentExportThreadRequest,
) -> AgentCommandResult<bool> {
    let source = state
        .prepare_export(request.launch.agent_id, &request.thread_id)
        .await
        .map_err(Error::from)?;
    let (answer, wait) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name("session.zip")
        .add_filter("ZIP", &["zip"])
        .save_file(move |picked| {
            drop(answer.send(picked));
        });

    let picked = wait.await.map_err(|_dropped| {
        Error::Plugin("the session export dialog closed without an answer".to_owned())
    })?;
    let Some(picked) = picked else {
        return Ok(false);
    };
    let destination = picked.into_path().map_err(|cause| {
        Error::File(format!(
            "the selected session export target is not a filesystem path: {cause}"
        ))
    })?;

    state
        .export_thread(source, destination)
        .await
        .map_err(Error::from)?;
    Ok(true)
}
