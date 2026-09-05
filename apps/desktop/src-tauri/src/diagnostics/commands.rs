use tauri::AppHandle;

use crate::diagnostics::crash_report::{NativeCrashReport, take_previous_crash_report};
use poietica_problem::Problem;

type DiagnosticsCommandResult<T> = Result<T, Problem>;

/// Returns and consumes the previous native process crash report.
///
/// The renderer receives a bounded DTO, not an arbitrary filesystem path or
/// unrestricted native error object.
///
/// # Errors
///
/// Returns an error when the stored crash report cannot be read or consumed.
#[tauri::command]
#[specta::specta]
pub fn diagnostics_take_previous_crash(
    app: AppHandle,
) -> DiagnosticsCommandResult<Option<NativeCrashReport>> {
    take_previous_crash_report(&app).map_err(Into::into)
}
