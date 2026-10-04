//! 运行时策略：不出自协议、由本客户端决定的时长与上限，单点发放。

use std::time::Duration;

/// 取消发出去之后，等轮终事件的宽限期。
///
/// `abort` 是协作式的：桥那边可能刚好正常跑完，也可能一直不报终帧。到期由本机
/// 把这一轮收摊，而不是让界面永远停在「正在取消」。
pub(crate) const CANCEL_GRACE: Duration = Duration::from_secs(10);

/// 收摊时等**已受理、未应答**的命令落地的最长期限。
///
/// 连接退休会把应答槽一起丢掉，在飞的调用方拿到的是 `Refused(Gone)` —— 那不是
/// 「它失败了」，是「它还没轮到」。所以退休前先让在飞的结清；拖着不走（桥卡死、
/// 对面不回）时由这个期限兜住，不能让一次换锚永远悬着。
pub(crate) const RETIRE_SETTLE: Duration = Duration::from_secs(2);
