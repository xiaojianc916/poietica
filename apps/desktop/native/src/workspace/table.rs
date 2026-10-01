use serde::Deserialize;
use specta::Type;

use crate::error::Error;
use poietica_problem::Problem;

const MAX_TABLE_EXPORT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum TableExportFormat {
    Csv,
    Markdown,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TableExportRequest {
    pub content: String,
    pub format: TableExportFormat,
}

/// 把一张 AI 回复里的表格保存到用户明确选择的位置。
///
/// 落点只能由宿主的保存对话框产生，渲染层不能指定任意磁盘位置。
///
/// # Errors
///
/// 内容超过上限、宿主没有给出落点或文件写入失败时返回脱敏后的 IPC 错误。
#[specta::specta]
#[allow(
    clippy::needless_pass_by_value,
    reason = "specta 命令函数的参数由 ipc::argument 按值解出，形状必须与生成契约里的具名参数一致"
)]
pub async fn table_export(request: TableExportRequest) -> Result<bool, Problem> {
    if request.content.len() > MAX_TABLE_EXPORT_BYTES {
        return Err(Problem::from(Error::Validation(
            "table export exceeds the size limit".to_owned(),
        )));
    }

    // ponytail: 选目录/导出对话框是宿主能力，由 Electron 主进程的 dialog.showOpenDialog 提供（见 apps/desktop/electron/main.ts 的 pickRoot port）；这里不再自己弹。
    let _ = request.format;

    Err(Error::Internal("the folder chooser is the host's job".to_owned()).into())
}
