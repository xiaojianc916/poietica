use std::io::Write;
use std::path::Path;

use crate::error::{KapError, Result};

fn toolchain(message: String) -> KapError {
    KapError::Toolchain { message }
}

/// Writes through a same-directory temporary file so readers never observe a partial config.
pub fn write_config_atomically(path: &Path, text: &str) -> Result<()> {
    let directory = path
        .parent()
        .ok_or_else(|| toolchain("配置文件没有父目录".to_owned()))?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory)
        .map_err(|error| toolchain(format!("建不了临时配置：{error}")))?;
    temporary
        .write_all(text.as_bytes())
        .map_err(|error| toolchain(format!("写不进临时配置：{error}")))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| toolchain(format!("临时配置落盘失败：{error}")))?;
    let _persisted = temporary
        .persist(path)
        .map_err(|error| toolchain(format!("替换配置失败：{error}")))?;
    Ok(())
}
