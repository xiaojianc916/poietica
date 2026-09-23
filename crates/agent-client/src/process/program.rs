//! 程序解析的转发层：实现在 crates/process-host，这里只把「起不来」翻成 AgentError。

pub use poietica_process_host::program::{Launcher, hide_console, resolve_launcher};

use crate::error::{AgentError, Result};
use std::path::PathBuf;

pub fn resolve_program(program: &str) -> Result<PathBuf> {
    poietica_process_host::program::resolve_program(program).map_err(|not_found| {
        AgentError::Spawn {
            message: not_found.message,
        }
    })
}

/// 随包发的边车在应用可执行文件旁边，不在 PATH 上。解析顺序见 process-host。
pub(crate) fn resolve_sidecar(program: &str) -> Result<PathBuf> {
    poietica_process_host::program::resolve_sidecar(program).map_err(|not_found| {
        AgentError::Spawn {
            message: not_found.message,
        }
    })
}
