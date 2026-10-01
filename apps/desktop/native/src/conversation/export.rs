use std::path::PathBuf;

use super::AgentCommandResult;
use super::dto::AgentExportThreadRequest;
use crate::error::Error;

/*
 * 导出：字节由 agent 自己写，落点由宿主的保存对话框给。
 *
 * 分两步是因为两件事各归各的：会话的 zip 只有 agent 写得出（它持有那条连接），
 * 而对话框挂在窗口上、只有 Electron 主进程开得出。渲染层先问宿主拿落点，
 * 再把落点连请求一起交过来；`None` 就是用户取消了。
 */
#[specta::specta]
#[allow(
    clippy::needless_pass_by_value,
    reason = "specta 命令函数的参数由 ipc::argument 按值解出，形状必须与生成契约里的具名参数一致"
)]
pub async fn agent_export_thread(request: AgentExportThreadRequest) -> AgentCommandResult<bool> {
    let state = crate::conversation::runtime()?;
    let source = state
        .prepare_export(request.launch.agent_id, &request.thread_id)
        .await
        .map_err(Error::from)?;

    let Some(destination) = request.destination else {
        return Ok(false);
    };

    state
        .export_thread(source, PathBuf::from(destination))
        .await
        .map_err(Error::from)?;

    Ok(true)
}
