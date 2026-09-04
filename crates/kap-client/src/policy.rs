//! 运行时策略：不出自协议、由本客户端决定的时长与上限，单点发放。

use std::time::Duration;

/// 取消被 kap 收下之后，等 turn.ended 的宽限期。:abort 是协作式的，不保证终帧
/// 一定回来；到期由本机把这一轮收摊，而不是永远停在正在取消。
pub(crate) const CANCEL_GRACE: Duration = Duration::from_secs(10);

/// 跟随 KAP 后台安装时的轮询节拍。
pub(crate) const CAPABILITY_POLL_INTERVAL: Duration = Duration::from_millis(700);

/// 安装等待上限十分钟：上游光 Windows runtime 一步就给 180s，之外还有下载、
/// 插件层与体检 —— 等短了会把还在装的判成装失败。
pub(crate) const CAPABILITY_POLL_ATTEMPTS: u32 = 600_000 / 700;
