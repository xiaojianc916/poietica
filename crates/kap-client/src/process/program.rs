//! 程序解析的转发层：实现在 crates/process-host，这里只把「起不来」翻成 KapError。

pub use poietica_process_host::program::{Launcher, hide_console, resolve_launcher};

use crate::error::{KapError, Result};
use std::path::PathBuf;

pub fn resolve_program(program: &str) -> Result<PathBuf> {
    poietica_process_host::program::resolve_program(program).map_err(|not_found| KapError::Spawn {
        message: not_found.message,
    })
}
