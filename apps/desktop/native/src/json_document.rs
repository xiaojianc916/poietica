//! 一份「键 → 值」的 JSON 文档：读回来是映射，写回去走临时文件加改名。
//!
//! settings.json 与 agents.json 是同一件事的两种命名 —— 一个根对象、一个键一格、
//! 顶层别的键原样留着。原子替换的纪律（半份文档不是合法状态，崩在中间只能看到上一版）
//! 只写一次，两处共用。

use std::path::Path;

use serde_json::{Map, Value};

use crate::error::{Error, Result};

/// 读一份文档。还没有这个文件就是空的 —— 那与「读不出」是两回事。
pub(crate) fn read_document(path: &Path) -> Result<Map<String, Value>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(error) => Err(Error::Io(error)),
    }
}

/// 把一格写进文档，其余键原样保留。临时文件 + 改名：半份文档不是合法状态。
pub(crate) fn write_document(path: &Path, key: &str, value: &Value) -> Result<()> {
    let mut document = read_document(path)?;

    document.insert(key.to_owned(), value.clone());

    let directory = path
        .parent()
        .ok_or_else(|| Error::Validation("a document store needs a parent directory".to_owned()))?;

    std::fs::create_dir_all(directory)?;

    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;

    serde_json::to_writer_pretty(&mut temporary, &document)?;
    std::io::Write::write_all(&mut temporary, b"\n")?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(path)
        .map_err(|failure| Error::Io(failure.error))?;

    Ok(())
}
