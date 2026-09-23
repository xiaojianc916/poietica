//! 运行时策略：不出自协议、由本客户端决定的时长与上限，单点发放。

use std::time::Duration;

/// 取消发出去之后，等轮终事件的宽限期。
///
/// `abort` 是协作式的：桥那边可能刚好正常跑完，也可能一直不报终帧。到期由本机
/// 把这一轮收摊，而不是让界面永远停在「正在取消」。
pub(crate) const CANCEL_GRACE: Duration = Duration::from_secs(10);
