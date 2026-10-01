use super::AgentCommandResult;
use super::dto::AgentExportThreadRequest;
use crate::error::Error;

/// 导出要先有落点，落点只能由宿主的保存对话框产生 —— 宿主没给落点就交不出文件。
#[specta::specta]
#[allow(
    clippy::needless_pass_by_value,
    reason = "specta 命令函数的参数由 ipc::argument 按值解出，形状必须与生成契约里的具名参数一致"
)]
pub async fn agent_export_thread(request: AgentExportThreadRequest) -> AgentCommandResult<bool> {
    // ponytail: 选目录/导出对话框是宿主能力，由 Electron 主进程的 dialog.showOpenDialog 提供（见 apps/desktop/electron/main.ts 的 pickRoot port）；这里不再自己弹。
    let _ = request;

    Err(Error::Internal("the folder chooser is the host's job".to_owned()).into())
}
