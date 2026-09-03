use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::Error;
use crate::ipc::commands::ledger::local_index::{
    LocalIndex, conversation, persistence, read_index,
};

use super::AgentCommandResult;
use super::NO_SUCH_CONVERSATION;
use super::dto::AgentExportThreadRequest;
use super::failure::translate;
use super::runtime::{AgentRuntime, ensure_session};

const NOTHING_TO_EXPORT: &str = "that conversation has no session owned by the selected agent";

#[tauri::command]
#[specta::specta]
pub async fn agent_export_thread(
    app: AppHandle,
    state: State<'_, AgentRuntime>,
    index: State<'_, LocalIndex>,
    request: AgentExportThreadRequest,
) -> AgentCommandResult<bool> {
    let thread_id = conversation(&request.thread_id)?;
    let stored = read_index(&index, move |store| {
        store.thread(thread_id).map_err(persistence)
    })
    .await?
    .ok_or_else(|| Error::NotFound(NO_SUCH_CONVERSATION.to_owned()))?;

    let session_id = stored
        .session_id
        .ok_or_else(|| Error::Validation(NOTHING_TO_EXPORT.to_owned()))?;
    if stored
        .agent_id
        .as_deref()
        .is_some_and(|owner| owner != request.launch.agent_id.as_str())
    {
        return Err(Error::Validation(NOTHING_TO_EXPORT.to_owned()).into());
    }

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

    let live = ensure_session(&app, &state, request.launch, stored.workspace_root).await?;
    live.client
        .export_session(session_id, destination)
        .await
        .map_err(translate)?;

    Ok(true)
}
