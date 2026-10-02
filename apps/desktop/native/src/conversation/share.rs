use super::{AgentCommandResult, dto::AgentShareThreadRequest};
use crate::conversation::dto::AgentSharedThread;
use crate::error::Error;

/*
 * 把一条会话传到 agent 自己的分享服务，交回链接。
 *
 * 与导出（export.rs）分成两个文件：导出要先让用户挑落点、然后字节由 agent 写盘，
 * 分享没有落点、只有一次上传，除了拿绑定之外没有共用的步骤，合并只会让两个读者
 * 挤在一个文件里（AGENTS.md §4 拆分判据 3）。
 *
 * 脱敏在桥那一侧按 agent 自己的设置办，这一层不碰 —— 密钥策略只有一处产地。
 */
#[specta::specta]
pub async fn agent_share_thread(
    request: AgentShareThreadRequest,
) -> AgentCommandResult<AgentSharedThread> {
    let state = crate::conversation::runtime()?;
    let source = state
        .prepare_export(crate::agent::profile::agent_id()?, &request.thread_id)
        .await
        .map_err(Error::from)?;

    let shared = state.share_thread(source).await.map_err(Error::from)?;

    Ok(AgentSharedThread {
        url: shared.url,
        truncated: shared.truncated,
    })
}
