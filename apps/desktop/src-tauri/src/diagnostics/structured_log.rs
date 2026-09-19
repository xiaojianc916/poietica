use std::path::PathBuf;

use log::LevelFilter;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

/// 这些 crate 的 debug 只讲它们自己的内部机制（如 `keyring_core` 每次启动都把凭据
/// 的 target_name、service、user 念一遍），冲掉本应用的那几行，凭据元数据常态落盘
/// 也不体面。全局阈值只定我们自己的下限，这里按 target 压到 warn：出事照样喊，
/// 平时闭嘴。黑名单永远可能漏，判据就是第一句；发现谁在刷屏，把 target 名
/// （crate 名连字符换下划线）照抄进来即可。
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

/// 日志落点由调用方给：全部落盘点都在同一数据根之下，`TargetKind::LogDir` 解析的
/// 平台固定位置在安装期选过别的根后会对不上。Stdout 只在 debug 注册：release 是
/// windows 子系统进程，没有附着控制台，每次写入是纯开销。轮转与单文件上限显式声明
/// 不吃默认值：日志落在用户磁盘上，无人看管地长下去是我们的问题。
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
            // 过滤器只作用在 Stdout：debug 及以下的账目（重连对账、握手指令这类）
            // 落盘即可，不在终端刷屏；文件与 webview 仍是全量。
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
