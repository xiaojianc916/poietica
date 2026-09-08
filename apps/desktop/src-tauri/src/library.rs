use poietica_library::{LibraryCatalog, LibraryError, LibraryReply, LibraryRequest, Vault};
use poietica_problem::{Code, DiagnosticId, Problem};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Debug, Default, Clone)]
pub(crate) struct LibraryHost(Arc<Mutex<Option<Vault>>>);

fn failure(error: LibraryError) -> Problem {
    let code = match &error {
        LibraryError::Conflict | LibraryError::Invalid(_) => Code::RequestInvalid,
        LibraryError::Io(_) | LibraryError::Content(_) => Code::FileUnavailable,
    };
    log::warn!("library operation failed: {error}");
    Problem::new(code, DiagnosticId::issue()).with_detail("reason", &error.to_string())
}

fn internal(error: impl std::fmt::Display) -> Problem {
    log::error!("library host failed: {error}");
    Problem::new(Code::Internal, DiagnosticId::issue())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn library_pick(
    app: AppHandle,
    host: State<'_, LibraryHost>,
) -> Result<Option<LibraryCatalog>, Problem> {
    let (answer, wait) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |picked| {
        drop(answer.send(picked));
    });
    let Some(picked) = wait.await.map_err(internal)? else {
        return Ok(None);
    };
    let path = PathBuf::from(picked.to_string());
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let vault = Vault::open(&path).map_err(failure)?;
        let catalog = vault.catalog("").map_err(failure)?;
        *host.0.lock().map_err(internal)? = Some(vault);
        Ok(Some(catalog))
    })
    .await
    .map_err(internal)?
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn library_execute(
    root: String,
    request: LibraryRequest,
    host: State<'_, LibraryHost>,
) -> Result<LibraryReply, Problem> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let selected = host.0.lock().map_err(internal)?;
        let vault = selected
            .as_ref()
            .ok_or_else(|| failure(LibraryError::Invalid("请先打开资料文件夹。".into())))?;
        if vault.identity() != root {
            return Err(failure(LibraryError::Invalid(
                "资料库已切换，本次请求未执行。".into(),
            )));
        }
        vault.execute(request).map_err(failure)
    })
    .await
    .map_err(internal)?
}
