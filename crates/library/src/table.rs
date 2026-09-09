//! CSV 的编解码。引号、内嵌换行与转义（RFC 4180）交给 csv crate，本文件只把
//! 宽窄不一的记录对齐到表头宽度。

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::{LibraryError, Result};

/// 一张表。表头即字段名，每行按表头宽度对齐。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TableSheet {
    pub header: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

/// Excel 导出的 CSV 带 UTF-8 BOM，不剥掉它会长进第一个字段名里。
const BOM: char = '\u{feff}';

fn broken(error: csv::Error) -> LibraryError {
    LibraryError::Invalid(format!("表格读不出来：{error}"))
}

pub(crate) fn decode(text: &str) -> Result<TableSheet> {
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .has_headers(false)
        .from_reader(text.strip_prefix(BOM).unwrap_or(text).as_bytes());
    let mut records = reader.records();
    let Some(first) = records.next() else {
        return Ok(TableSheet {
            header: Vec::new(),
            rows: Vec::new(),
        });
    };
    let header: Vec<String> = first.map_err(broken)?.iter().map(str::to_owned).collect();
    let mut rows = Vec::new();

    for record in records {
        let mut row: Vec<String> = record.map_err(broken)?.iter().map(str::to_owned).collect();

        row.resize(header.len(), String::new());
        rows.push(row);
    }

    Ok(TableSheet { header, rows })
}

pub(crate) fn encode(sheet: &TableSheet) -> Result<String> {
    if sheet.header.is_empty() {
        return Ok(String::new());
    }

    let mut writer = csv::WriterBuilder::new()
        .has_headers(false)
        .from_writer(Vec::new());

    writer.write_record(&sheet.header).map_err(broken)?;

    for row in &sheet.rows {
        let mut aligned = row.clone();

        aligned.resize(sheet.header.len(), String::new());
        writer.write_record(&aligned).map_err(broken)?;
    }

    let bytes = writer
        .into_inner()
        .map_err(|error| LibraryError::Invalid(format!("表格写不出去：{error}")))?;

    String::from_utf8(bytes).map_err(|_| LibraryError::Invalid("表格不是 UTF-8。".to_owned()))
}
