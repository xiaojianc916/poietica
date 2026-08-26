//! 把 agent 那侧的失败折进这个程序既有的错误面。

use crate::error::Error;
use poietica_agent_runtime_native::{KapError, Refusal};

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
/// 分两路，因为两边的来源不同。这一侧判定的拒绝是本仓的字面量，原样上屏；agent
/// 报回来的原因可能带路径或系统细节，仍然落到 `Internal` 的固定文案 —— 但先写进
/// 日志。
///
/// 此前两路合一：七种互不相同的失败共用一句「应用操作失败」，且那个 message 在
/// 这一行之后再没有任何地方留下过。原来的注释说「不给 agent 加变体，多一条 arm
/// 就是新的泄漏口」，那句话把两件事混了 —— 泄漏来自把 native detail 当成
/// `public_message` 原样返回，不来自多一个变体。
pub(super) fn translate(error: KapError) -> Error {
    match error {
        KapError::Refused(reason) => Error::AgentCli(refusal(reason).to_owned()),
        // The enum is non-exhaustive, so the wildcard arm is required.
        //
        // 原样上屏，不换一句好听的。这是一个桌面单机程序：屏幕前的人就是跑这个
        // 进程的人，agent 的回话对他不是秘密，是他唯一拿得去排查的东西。此前这
        // 里折成一句「应用操作失败」，于是 "Authentication required" 只留在日志
        // 里 —— 而上一版我把它换成了一句猜出来的「多半是还没登录」，那比不说更
        // 坏：它用一个不确切的说法顶掉了一个确切的说法。
        other => {
            log::error!("the agent request failed: {other}");

            Error::AgentCli(other.to_string())
        }
    }
}
