use serde::Deserialize;
use specta::Type;
use tauri::{AppHandle, command};
use tauri_plugin_dialog::DialogExt;

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

impl TableExportFormat {
    fn file_name(self) -> &'static str {
        match self {
            Self::Csv => "table.csv",
            Self::Markdown => "table.md",
        }
    }

    fn filter_name(self) -> &'static str {
        match self {
            Self::Csv => "CSV",
            Self::Markdown => "Markdown",
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Csv => "csv",
            Self::Markdown => "md",
        }
    }
}

/// 把一张 AI 回复里的表格保存到用户明确选择的位置。
///
/// 路径只能由系统保存对话框产生，渲染层不能指定任意磁盘位置。用户取消时返回
/// false；成功写入时返回 true。
///
/// # Errors
///
/// 内容超过上限、保存对话框异常或文件写入失败时返回脱敏后的 IPC 错误。
#[command]
#[specta::specta]
pub async fn table_export(app: AppHandle, request: TableExportRequest) -> Result<bool, Problem> {
    if request.content.len() > MAX_TABLE_EXPORT_BYTES {
        return Err(Problem::from(Error::Validation(
            "table export exceeds the size limit".to_owned(),
        )));
    }

    let format = request.format;
    let (answer, wait) = tokio::sync::oneshot::channel();

    app.dialog()
        .file()
        .set_file_name(format.file_name())
        .add_filter(format.filter_name(), &[format.extension()])
        .save_file(move |picked| {
            drop(answer.send(picked));
        });

    let picked = wait
        .await
        .inspect_err(|_| {
            log::warn!("the table export dialog went away without answering");
        })
        .ok()
        .flatten();

    let Some(picked) = picked else {
        return Ok(false);
    };

    let path = picked.into_path().map_err(|cause| {
        Problem::from(Error::File(format!(
            "the selected table export target is not a filesystem path: {cause}"
        )))
    })?;

    tokio::fs::write(path, request.content)
        .await
        .map_err(|cause| Problem::from(Error::Io(cause)))?;

    Ok(true)
}
