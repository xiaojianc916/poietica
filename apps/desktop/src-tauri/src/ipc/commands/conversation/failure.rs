//! 把 agent 那侧的失败折进这个程序既有的错误面。

use crate::error::Error;
use poietica_kap_client::{KapError, Refusal};

/// 这一侧自己判定的拒绝，说的话。
///
/// 全是本仓库的字面量常量，没有一处把 agent 的回话、外部输入或系统错误拼进去
/// —— 这正是 `Error::AgentCli` 那个变体写下来的透传判据，所以它们可以原样上屏。
/// 而这两件恰恰是用户唯一能自己解决的事。
const fn refusal(reason: Refusal) -> &'static str {
    match reason {
        Refusal::UnknownSession => "这条对话的会话已经失效，请重新打开它",
        Refusal::Gone => "agent 已经退出，请重新发起对话",
    }
}

/// Folds an agent failure into the application's existing error surface.
///
/// 两路：本仓字面量的拒绝原样上屏；agent 报回来的原话先落日志再原样上屏 ——
/// 桌面单机程序里屏幕前的人就是跑这个进程的人，确切的原话比好听的猜测有用。
pub(super) fn translate(error: KapError) -> Error {
    match error {
        KapError::Io(cause) => Error::Io(cause),
        KapError::Refused(reason) => Error::AgentCli(refusal(reason).to_owned()),
        // The enum is non-exhaustive, so the wildcard arm is required.
        //
        // agent 的回话是用户唯一拿得去排查的东西，不折成一句好听的。
        other => {
            log::error!("the agent request failed: {other}");

            Error::AgentCli(other.to_string())
        }
    }
}
