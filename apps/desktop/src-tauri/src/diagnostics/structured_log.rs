use std::fs::OpenOptions;
use std::path::{Path, PathBuf};

use log::LevelFilter;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

const FOREIGN: &[&str] = &[
    "h2",
    "hyper",
    "hyper_util",
    "keyring_core",
    "rmcp",
    "reqwest",
    "rustls",
    "tracing",
    "tungstenite",
];

const LOG_FILE_STEM: &str = "poietica";

/// 文件落点偶被外部瞬态拒绝（本机 os error 5，提权亦然，非 ACL/并发实例）；
/// 探测失败就退到 stdout/webview，日志初始化失败不能拖死整个应用。
#[allow(
    clippy::print_stderr,
    reason = "the logger is not up yet; stderr is the only channel left when the file target is denied"
)]
fn file_target(directory: &Path) -> Option<Target> {
    let log_file = directory.join(LOG_FILE_STEM).with_extension("log");
    match OpenOptions::new().create(true).append(true).open(&log_file) {
        Ok(_) => Some(Target::new(TargetKind::Folder {
            path: directory.to_path_buf(),
            file_name: Some(LOG_FILE_STEM.to_owned()),
        })),
        Err(error) => {
            eprintln!("file log unavailable ({error}); falling back to stdout/webview");
            None
        }
    }
}

/// 落点由调用方给：安装期自选数据根后，`TargetKind::LogDir` 的平台固定位置会对不上。
pub fn plugin(directory: PathBuf) -> tauri_plugin_log::Builder {
    let mut targets = Vec::new();
    if let Some(target) = file_target(&directory) {
        targets.push(target);
    }
    targets.push(Target::new(TargetKind::Webview));

    let builder = tauri_plugin_log::Builder::new()
        .targets(targets)
        .rotation_strategy(RotationStrategy::KeepOne)
        .max_file_size(5_000_000)
        .timezone_strategy(TimezoneStrategy::UseLocal);

    let mut builder = if cfg!(debug_assertions) {
        builder
            .target(
                Target::new(TargetKind::Stdout)
                    .filter(|metadata: &log::Metadata<'_>| metadata.level() > log::Level::Debug),
            )
            .level(LevelFilter::Debug)
    } else {
        builder.level(LevelFilter::Info)
    };

    for target in FOREIGN {
        builder = builder.level_for(*target, LevelFilter::Warn);
    }

    builder
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        reason = "tests operate on known-good fixtures; a broken assumption must fail the test loudly"
    )]

    use super::file_target;

    #[test]
    fn unwritable_fallout_omits_file_target() {
        /* create(true) 只建文件不建父目录：父目录不存在时 open 必败。 */
        let directory = std::env::temp_dir().join("poietica-log-probe-missing-parent");
        assert!(file_target(&directory).is_none());
    }

    #[test]
    fn writable_directory_yields_file_target() {
        let directory = std::env::temp_dir().join("poietica-log-probe-writable");
        std::fs::create_dir_all(&directory).expect("临时测试目录必须可创建");
        assert!(file_target(&directory).is_some());
        let _ = std::fs::remove_dir_all(&directory);
    }
}
