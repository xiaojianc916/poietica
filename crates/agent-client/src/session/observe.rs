//! 一次提交现在怎么样了：从本机账本读，不再问 agent。
//!
//! 旧的判据读的是 kap 的 completion 投影（REST 拉一页，再从 prompts/items 里推
//! 断）。桥这条路不需要那个回合：轮终由 `turn_end` 事件直接报给本层，prompt 的
//! 准入也落在本层的帧日志里（recorder 的 PromptAdmitted / RunFinished /
//! RunFailed）。所以答案本来就在手上，问一次网络只会多一个不一致的来源。

use crate::error::Result;
use crate::session::AgentClient;

/// 一次提交的观察结论。词表与产品侧一致，不是第二套。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PromptObservation {
    Active,
    Succeeded,
    Failed,
    Cancelled,
    Missing,
}

/// 问这条连接：这个 prompt 现在是什么状态。
///
/// `prompt` 是提交时给出的幂等键（automation 用 run id，界面用一次性 uuid）。
/// 会话不在这条连接上就是 Missing —— 那是「不是这条连接的事」，不是失败。
pub async fn observe_prompt(
    client: &AgentClient,
    session_id: &str,
    prompt: &str,
) -> Result<PromptObservation> {
    client.prompt_state(session_id, prompt).await
}
