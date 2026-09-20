use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, command};
use tauri_specta::Event as _;

use poietica_problem::Problem;
use poietica_terminal_native::{TerminalError, TerminalSessions, TerminalSignal, TerminalSink};

use crate::error::Error;

#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum TerminalChunk {
    Output(String),
    Exited,
}

#[derive(Clone, Debug, Deserialize, Serialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStreamed {
    pub root: String,
    pub chunk: TerminalChunk,
}

#[derive(Debug, Default)]
pub struct TerminalHost(TerminalSessions);

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

#[command]
#[specta::specta]
pub async fn terminal_close(app: AppHandle, root: String) {
    app.state::<TerminalHost>().0.close(&root);
}
