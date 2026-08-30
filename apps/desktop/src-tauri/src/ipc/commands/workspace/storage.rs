//! 这个应用的数据落在哪 —— 说给用户听的那一句。
//!
//! 路径由 `paths` 算，这里只负责把它变成一个字符串交出去。关于面板要显示它，
//! 而一个说不出自己数据在哪的桌面应用，用户没有办法备份，也没有办法搬走。

use tauri::{AppHandle, command};

use crate::error::Result;
use crate::paths::data_root;
use poietica_problem::Problem;

/// 这台机器上，这个应用的数据根。
///
/// # Errors
///
/// 根目录无法解析或创建时返回错误。
#[command]
#[specta::specta]
pub async fn storage_data_directory(app: AppHandle) -> std::result::Result<String, Problem> {
    (|| -> Result<String> { Ok(data_root(&app)?.to_string_lossy().into_owned()) })()
        .map_err(Problem::from)
}
