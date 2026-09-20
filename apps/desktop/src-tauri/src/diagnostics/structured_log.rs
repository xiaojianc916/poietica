use std::path::PathBuf;

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

/// 落点由调用方给：安装期自选数据根后，`TargetKind::LogDir` 的平台固定位置会对不上。
pub fn plugin(directory: PathBuf) -> tauri_plugin_log::Builder {
    let builder = tauri_plugin_log::Builder::new()
        .targets([
            Target::new(TargetKind::Folder {
                path: directory,
                file_name: Some("poietica".to_owned()),
            }),
            Target::new(TargetKind::Webview),
        ])
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
