//! Kimi 专属：把归档状态写回它官方的 state.json。
//!
//! Kimi 的归档状态属于 Kimi 自己的会话，而 Poietica 不启动 kimi web，不能依赖
//! 它的 HTTP PATCH 路由。官方归档路由最终写的就是 state.json 里的三格：
//! `archived`、`auto_archive_exempt`、`archived_at`。这里写同一份文件、
//! 同一组字段，并保留其它所有字段；找不到官方状态文件时拒绝本地归档，避免两边
//! 显示出两个答案。行为锚点：TS 版 Kimi Code（npm @moonshot-ai/kimi-code）的
//! 归档实现，2026-08 核对。
//!
//! 单独成档，因为这是 agent 专属知识（AGENTS.md §4）：通用层只在 thread.rs 的
//! 归档命令里按 agent_id 分发到这里，不认识这份文件的内部。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{Error, Result};

/// Writes the fields used by Kimi Code's official archive implementation.
pub(super) fn sync_kimi_archive_state(home: &Path, session_id: &str, archived: bool) -> Result<()> {
    let state_path = find_kimi_state(home, session_id, 0)?.ok_or_else(|| {
        Error::Internal(format!(
            "找不到 Kimi 会话 {session_id} 的官方 state.json，归档已取消"
        ))
    })?;

    let text =
        fs::read_to_string(&state_path).map_err(|error| Error::Persistence(error.to_string()))?;

    let mut state: serde_json::Value =
        serde_json::from_str(&text).map_err(|error| Error::Persistence(error.to_string()))?;

    let object = state
        .as_object_mut()
        .ok_or_else(|| Error::Persistence("Kimi state.json 的根不是对象".to_owned()))?;

    object.insert("archived".to_owned(), serde_json::Value::Bool(archived));

    object.insert(
        "auto_archive_exempt".to_owned(),
        serde_json::Value::Bool(!archived),
    );

    let archived_at = if archived {
        let seconds = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| Error::Internal(error.to_string()))?
            .as_secs_f64();

        serde_json::Number::from_f64(seconds)
            .map(serde_json::Value::Number)
            .ok_or_else(|| Error::Internal("无法生成 Kimi 归档时间".to_owned()))?
    } else {
        serde_json::Value::Null
    };

    object.insert("archived_at".to_owned(), archived_at);

    let parent = state_path
        .parent()
        .ok_or_else(|| Error::Persistence("Kimi state.json 没有父目录".to_owned()))?;

    /*
     * tempfile::persist 使用同目录临时文件替换目标文件，避免只写到一半时
     * Kimi 读到截断 JSON。
     */
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| Error::Persistence(error.to_string()))?;

    serde_json::to_writer_pretty(&mut temporary, &state)
        .map_err(|error| Error::Persistence(error.to_string()))?;

    temporary
        .write_all(b"\n")
        .map_err(|error| Error::Persistence(error.to_string()))?;

    temporary
        .as_file()
        .sync_all()
        .map_err(|error| Error::Persistence(error.to_string()))?;

    temporary
        .persist(&state_path)
        .map_err(|error| Error::Persistence(error.error.to_string()))?;

    Ok(())
}

/// Finds a session state below the controlled Kimi home without reproducing
/// Kimi's work-directory hash algorithm.
fn find_kimi_state(directory: &Path, session_id: &str, depth: usize) -> Result<Option<PathBuf>> {
    if depth > 10 || !directory.is_dir() {
        return Ok(None);
    }

    let entries = fs::read_dir(directory).map_err(|error| Error::Persistence(error.to_string()))?;

    let prefixed = format!("session_{session_id}");

    for entry in entries {
        let entry = entry.map_err(|error| Error::Persistence(error.to_string()))?;

        let file_type = entry
            .file_type()
            .map_err(|error| Error::Persistence(error.to_string()))?;

        if !file_type.is_dir() {
            continue;
        }

        let path = entry.path();
        let name = entry.file_name();

        if name == session_id || name == prefixed.as_str() {
            let state = path.join("state.json");

            if state.is_file() {
                return Ok(Some(state));
            }
        }

        if let Some(found) = find_kimi_state(&path, session_id, depth + 1)? {
            return Ok(Some(found));
        }
    }

    Ok(None)
}
