use std::path::PathBuf;

use log::LevelFilter;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

/// 不归我们管的 crate。
///
/// 它们的 debug 讲的是自己的内部机制 —— `keyring_core` 每次启动都把凭据的
/// `target_name、service、user` 念一遍 —— 对读日志的人没有信息量，还把真正
/// 属于本应用的那几行冲掉，凭据元数据常态落盘本身也不体面。
///
/// 全局阈值只定我们自己的下限，第三方按 target 单独压到 warn：出事照样喊，
/// 平时闭嘴。
///
/// 这是一张黑名单，所以它永远可能漏。判据就是上面那句：这条日志讲的是它自己的
/// 内部机制，还是这个应用在做什么。发现终端里有谁在刷屏，把方括号里那个 target
/// 名照抄进来即可 —— 名字就是 crate 名把连字符换成下划线。
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

/// 日志落点。
///
/// 目录由调用方给，不由插件自己按平台猜：这个应用的全部落盘点都在同一个数据
/// 根之下，日志没有理由是那个根之外的第三处。`TargetKind::LogDir` 解析的是
/// `app_log_dir()`，那是平台固定的位置，安装期选过别的根之后它就对不上了。
///
/// Stdout 只在 debug 注册：release 是 windows 子系统进程，没有附着的控制台，
/// 那个 target 的每一次写入都是纯开销。
///
/// 轮转策略与单文件上限显式声明，不吃插件默认值 —— 这份日志落在用户自己的磁盘
/// 上，无人看管地长下去是我们的问题，不是用户的。
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
            // 终端只列值得停下来的：debug 及以下的账目（重连对账、握手指令这类）落盘
            // 即可，不在终端刷屏。文件与 webview 仍是全量，过滤器只作用在 Stdout 这一个落点。
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
