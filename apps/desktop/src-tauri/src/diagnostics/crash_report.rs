use std::{backtrace::Backtrace, fs, panic::PanicHookInfo, path::Path};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::Result;
use crate::paths::crash_report;

const MAX_MESSAGE_LENGTH: usize = 8_192;
const MAX_BACKTRACE_LENGTH: usize = 64_000;
const MAX_LOCATION_LENGTH: usize = 4_096;

#[derive(Clone, Debug, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NativeCrashReport {
    pub incident_id: String,
    pub occurred_at: String,
    pub process: String,
    pub thread: String,
    pub message: String,
    pub location: Option<String>,
    pub backtrace: String,
    pub app_version: String,
    pub target_os: String,
    pub target_arch: String,
}

/// Installs the process-level panic recorder.
///
/// A Rust panic can terminate the native process before the `WebView` is able to
/// render anything. The panic hook therefore writes a local crash report that
/// is consumed on the next launch.
#[allow(
    clippy::print_stderr,
    reason = "the panic hook must still reach stderr when the logger is already down"
)]
pub fn install(app: &AppHandle) -> Result<()> {
    let report_path = crash_report(app)?;

    let app_version = app.package_info().version.to_string();
    let previous_hook = std::panic::take_hook();

    std::panic::set_hook(Box::new(move |panic_info| {
        let report = create_report(panic_info, &app_version);

        if let Err(error) = write_report(&report_path, &report) {
            eprintln!("[Poietica] failed to persist native crash report: {error}");
        }

        previous_hook(panic_info);
    }));

    Ok(())
}

/// Reads and consumes the previous crash report.
///
/// Reports are removed after a successful read so reloading the renderer does
/// not display the same historical crash indefinitely.
pub fn take_previous_crash_report(app: &AppHandle) -> Result<Option<NativeCrashReport>> {
    let report_path = crash_report(app)?;

    if !report_path.exists() {
        return Ok(None);
    }

    let source = match fs::read_to_string(&report_path) {
        Ok(source) => source,
        Err(error) => {
            log::error!("failed to read native crash report: {error}");

            let _ = fs::remove_file(&report_path);
            return Ok(None);
        }
    };

    let report = match serde_json::from_str::<NativeCrashReport>(&source) {
        Ok(report) => report,
        Err(error) => {
            log::error!("invalid native crash report was discarded: {error}");

            let _ = fs::remove_file(&report_path);
            return Ok(None);
        }
    };

    fs::remove_file(&report_path)?;

    Ok(Some(report))
}

fn create_report(panic_info: &PanicHookInfo<'_>, app_version: &str) -> NativeCrashReport {
    let current_thread = std::thread::current();

    let thread_name = current_thread.name().unwrap_or("unnamed").to_owned();

    let message = panic_payload_message(panic_info);

    let location = panic_info.location().map(|location| {
        truncate(
            format!(
                "{}:{}:{}",
                location.file(),
                location.line(),
                location.column()
            ),
            MAX_LOCATION_LENGTH,
        )
    });

    let backtrace = truncate(Backtrace::force_capture().to_string(), MAX_BACKTRACE_LENGTH);

    NativeCrashReport {
        incident_id: format!("native-{}", Uuid::now_v7()),
        occurred_at: current_timestamp(),
        process: "poietica".to_owned(),
        thread: truncate(thread_name, 256),
        message: truncate(message, MAX_MESSAGE_LENGTH),
        location,
        backtrace,
        app_version: app_version.to_owned(),
        target_os: std::env::consts::OS.to_owned(),
        target_arch: std::env::consts::ARCH.to_owned(),
    }
}

fn panic_payload_message(panic_info: &PanicHookInfo<'_>) -> String {
    if let Some(message) = panic_info.payload().downcast_ref::<&str>() {
        return (*message).to_owned();
    }

    if let Some(message) = panic_info.payload().downcast_ref::<String>() {
        return message.clone();
    }

    "Rust panic with a non-string payload".to_owned()
}

/// 崩溃报告直接落盘。
///
/// 旧文档保存所依赖的原子写实现已随旧产品形态一并移除。崩溃报告是尽力而为的
/// 诊断产物，写失败只损失一份报告，不为它保留文档编解码器的写路径。
fn write_report(path: &Path, report: &NativeCrashReport) -> std::io::Result<()> {
    let serialized = serde_json::to_vec_pretty(report).map_err(std::io::Error::other)?;

    fs::write(path, &serialized)
}

fn current_timestamp() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| OffsetDateTime::now_utc().unix_timestamp().to_string())
}

fn truncate(mut value: String, maximum_length: usize) -> String {
    if value.len() <= maximum_length {
        return value;
    }

    while !value.is_char_boundary(maximum_length.min(value.len())) {
        value.pop();
    }

    value.truncate(maximum_length);
    value.push_str("\n[Native diagnostic value truncated]");

    value
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        clippy::unwrap_used,
        clippy::panic,
        clippy::indexing_slicing,
        clippy::shadow_unrelated,
        reason = "tests operate on known-good fixtures; a broken assumption must fail the test loudly"
    )]

    use super::{MAX_MESSAGE_LENGTH, truncate};

    #[test]
    fn short_values_are_not_changed() {
        assert_eq!(truncate("panic".to_owned(), 32), "panic");
    }

    #[test]
    fn long_values_are_bounded() {
        let source = "a".repeat(MAX_MESSAGE_LENGTH + 100);
        let result = truncate(source, MAX_MESSAGE_LENGTH);

        assert!(result.len() < MAX_MESSAGE_LENGTH + 100);
        assert!(result.contains("truncated"));
    }

    #[test]
    fn unicode_truncation_preserves_utf8_boundaries() {
        let result = truncate("会话崩溃测试".to_owned(), 5);

        assert!(result.is_char_boundary(result.len()));
        assert!(result.contains("truncated"));
    }
}
