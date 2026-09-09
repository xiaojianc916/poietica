//! 资料库的宿主侧：把应用自己的资料根交给 Vault，并在导入时代用户打开系统文件选择器。

use std::path::PathBuf;

use poietica_library::{LibraryError, LibraryReply, LibraryRequest, Vault};
use poietica_problem::{Code, DiagnosticId, Problem};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

fn failure(error: LibraryError) -> Problem {
    let code = match &error {
        LibraryError::Conflict | LibraryError::Invalid(_) => Code::RequestInvalid,
        LibraryError::Io(_) => Code::FileUnavailable,
    };

    log::warn!("library request failed: {error}");

    Problem::new(code, DiagnosticId::issue()).with_detail("reason", &error.to_string())
}

fn internal(error: impl std::fmt::Display) -> Problem {
    log::error!("library host failed: {error}");

    Problem::new(Code::Internal, DiagnosticId::issue())
}

/// 资料库的根不由渲染层选、也不由渲染层传：它是本应用数据根下的一格。
fn vault(app: &AppHandle) -> Result<Vault, Problem> {
    let root = crate::paths::library_root(app).map_err(Problem::from)?;

    Vault::open(&root).map_err(failure)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn library_execute(
    app: AppHandle,
    request: LibraryRequest,
) -> Result<LibraryReply, Problem> {
    tauri::async_runtime::spawn_blocking(move || vault(&app)?.execute(request).map_err(failure))
        .await
        .map_err(internal)?
}

/// 选一份库外的文件复制进来。用户取消时返回 None。
#[tauri::command]
#[specta::specta]
pub(crate) async fn library_import(
    app: AppHandle,
    parent: String,
) -> Result<Option<LibraryReply>, Problem> {
    let (answer, picked) = tokio::sync::oneshot::channel();

    app.dialog()
        .file()
        .add_filter("资料", &["md", "csv", "html"])
        .pick_file(move |chosen| {
            drop(answer.send(chosen));
        });

    let Some(chosen) = picked.await.map_err(internal)? else {
        return Ok(None);
    };
    let source = PathBuf::from(chosen.to_string());
    let placed = tauri::async_runtime::spawn_blocking(move || {
        vault(&app)?.import(&parent, &source).map_err(failure)
    })
    .await
    .map_err(internal)??;

    Ok(Some(LibraryReply::Placed(placed)))
}
