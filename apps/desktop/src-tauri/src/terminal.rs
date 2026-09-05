//! 终端那一格的 IPC 面：会话表的持有者、DTO 互转、事件投递。

use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, command};
use tauri_specta::Event as _;

use poietica_problem::Problem;
use poietica_terminal_native::{TerminalError, TerminalSessions, TerminalSignal, TerminalSink};

use crate::error::Error;

/// 一段 PTY 字节，或一次退出。字节是 base64：Tauri 的事件与命令走 JSON。
#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum TerminalChunk {
    Output(String),
    Exited,
}

/// 播给渲染层的一跳。root 是会话键，也就是这条对话的工作目录。
#[derive(Clone, Debug, Deserialize, Serialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStreamed {
    pub root: String,
    pub chunk: TerminalChunk,
}

/// 会话表的进程级持有者。组合根 manage 一份。
#[derive(Debug, Default)]
pub struct TerminalHost(TerminalSessions);

/// 失败分类只有这一处：目录不对是入参问题，键不在是找不到，其余是内部故障。
fn classify(error: TerminalError) -> Error {
    let message = error.to_string();

    match error {
        TerminalError::WorkingDirectory(_) => Error::Validation(message),
        TerminalError::Unknown(_) => Error::NotFound(message),
        TerminalError::Start(_) | TerminalError::Control(_) | TerminalError::Io(_) => {
            Error::Internal(message)
        }
    }
}

/// 字节离开原生侧的唯一出口。
fn sink(app: &AppHandle) -> TerminalSink {
    let handle = app.clone();

    Arc::new(move |root: &str, signal: TerminalSignal| {
        let chunk = match signal {
            TerminalSignal::Output(bytes) => {
                TerminalChunk::Output(base64::engine::general_purpose::STANDARD.encode(bytes))
            }
            TerminalSignal::Exited => TerminalChunk::Exited,
        };
        let streamed = TerminalStreamed {
            root: root.to_owned(),
            chunk,
        };

        if let Err(error) = streamed.emit(&handle) {
            log::warn!("terminal-streamed event could not be delivered: {error}");
        }
    })
}

/// 接上这个工作目录的终端；没有就开一条。回放经事件通道交回。
#[command]
#[specta::specta]
pub async fn terminal_attach(
    app: AppHandle,
    root: String,
    cols: u16,
    rows: u16,
) -> Result<(), Problem> {
    let sink = sink(&app);

    app.state::<TerminalHost>()
        .0
        .attach(&root, &PathBuf::from(&root), cols, rows, &sink)
        .map_err(classify)?;

    Ok(())
}

/// 渲染层的键入与粘贴。
#[command]
#[specta::specta]
pub async fn terminal_write(app: AppHandle, root: String, data: String) -> Result<(), Problem> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|error| Error::Validation(error.to_string()))?;

    app.state::<TerminalHost>()
        .0
        .write(&root, &bytes)
        .map_err(classify)?;

    Ok(())
}

/// 渲染层量出来的网格。
#[command]
#[specta::specta]
pub async fn terminal_resize(
    app: AppHandle,
    root: String,
    cols: u16,
    rows: u16,
) -> Result<(), Problem> {
    app.state::<TerminalHost>()
        .0
        .resize(&root, cols, rows)
        .map_err(classify)?;

    Ok(())
}

/// 关掉这一格：子进程与读线程随会话一起收场。已经关掉的键不是故障。
#[command]
#[specta::specta]
pub async fn terminal_close(app: AppHandle, root: String) {
    app.state::<TerminalHost>().0.close(&root);
}
