use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use base64::Engine as _;
use serde::{Deserialize, Serialize};

use poietica_problem::Problem;
use poietica_terminal_native::{TerminalError, TerminalSessions, TerminalSignal, TerminalSink};

use crate::error::Error;

#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum TerminalChunk {
    Output(String),
    Exited,
}

#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStreamed {
    pub root: String,
    pub chunk: TerminalChunk,
}

#[derive(Debug, Default)]
pub struct TerminalHost(TerminalSessions);

/// 终端会话是进程级的：一条会话从 attach 到 close 跨很多条命令，住 State 就是第二个所有者。
static HOST: OnceLock<TerminalHost> = OnceLock::new();

fn host() -> &'static TerminalHost {
    HOST.get_or_init(TerminalHost::default)
}

fn classify(error: &TerminalError) -> Error {
    let message = error.to_string();

    match error {
        TerminalError::WorkingDirectory(_) => Error::Validation(message),
        TerminalError::Unknown(_) => Error::NotFound(message),
        TerminalError::Start(_) | TerminalError::Control(_) | TerminalError::Io(_) => {
            Error::Internal(message)
        }
    }
}

fn sink() -> TerminalSink {
    Arc::new(|root: &str, signal: TerminalSignal| {
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

        match serde_json::to_value(&streamed) {
            Ok(payload) => crate::transport::emit("terminal_streamed", &payload),
            Err(error) => log::warn!("terminal output could not be encoded: {error}"),
        }
    })
}

#[specta::specta]
pub async fn terminal_attach(root: String, cols: u16, rows: u16) -> Result<(), Problem> {
    let sink = sink();

    host()
        .0
        .attach(&root, &PathBuf::from(&root), cols, rows, &sink)
        .map_err(|error| classify(&error))?;

    Ok(())
}

#[specta::specta]
pub async fn terminal_write(root: String, data: String) -> Result<(), Problem> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|error| Error::Validation(error.to_string()))?;

    host()
        .0
        .write(&root, &bytes)
        .map_err(|error| classify(&error))?;

    Ok(())
}

#[specta::specta]
pub async fn terminal_resize(root: String, cols: u16, rows: u16) -> Result<(), Problem> {
    host()
        .0
        .resize(&root, cols, rows)
        .map_err(|error| classify(&error))?;

    Ok(())
}

#[specta::specta]
pub async fn terminal_close(root: String) {
    host().0.close(&root);
}
