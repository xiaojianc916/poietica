//! 程序解析的转发层：实现在 crates/process-host，这里只把「起不来」翻成 AgentError。

pub use poietica_process_host::program::{Launcher, hide_console, resolve_launcher};

pub(crate) use poietica_process_host::program::beside_exe;

use crate::error::{AgentError, Result};
use std::path::{Path, PathBuf};

pub fn resolve_program(program: &str) -> Result<PathBuf> {
    poietica_process_host::program::resolve_program(program).map_err(|not_found| {
        AgentError::Spawn {
            message: not_found.message,
        }
    })
}

/// 随包发的运行时：先找随包目录，再回落到 PATH（开发期手动跑源码版用得上）。
pub(crate) fn resolve_sidecar(directory: &Path, program: &str) -> Result<PathBuf> {
    poietica_process_host::program::resolve_sidecar(directory, program).map_err(|not_found| {
        AgentError::Spawn {
            message: not_found.message,
        }
    })
}
