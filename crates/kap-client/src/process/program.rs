//! 把档案里写的程序名解析成一条真的能启动的路径。
//!
//! 解析、垫片包装、桌面进程策略都住在 crates/process-host —— 那是全仓的进程
//! 边缘，git-adapter 与宿主共用同一份。这一层只把它翻成 KapError，让
//! 「起不来」在这条错误链上仍然是一个变体。

pub use poietica_process_host::program::{Launcher, hide_console, resolve_launcher};

use crate::error::{KapError, Result};
use std::path::PathBuf;

/// 与 [`resolve_launcher`] 同一产地；这条路上的缺程序是错误，不是缺席。
///
/// # Errors
///
/// 在这台机器的搜索路径上找不到这个程序时返回 [`KapError::Spawn`]。
pub fn resolve_program(program: &str) -> Result<PathBuf> {
    poietica_process_host::program::resolve_program(program).map_err(|not_found| KapError::Spawn {
        message: not_found.message,
    })
}
