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
    /// 按列对齐的列类型。None 表示未指定，界面按列里的值推断。
    /// 类型只住在边车文件里（见 ADR 0043），CSV 本体保持纯表格。
    pub kinds: Vec<Option<SheetFieldKind>>,
}

/// 列类型的唯一词汇（ADR 0043）。TS 侧经生成绑定引用，不手抄。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SheetFieldKind {
    Text,
    Number,
    Currency,
    Select,
    MultiSelect,
    Date,
    Person,
    Checkbox,
    Link,
    Email,
    Phone,
    Image,
    Attachment,
}

impl SheetFieldKind {
    /// 边车里的名字。未知名字返回 None：新版本加的类型不该打断老版本开表。
    fn named(name: &str) -> Option<Self> {
        Some(match name {
            "text" => Self::Text,
            "number" => Self::Number,
            "currency" => Self::Currency,
            "select" => Self::Select,
            "multiSelect" => Self::MultiSelect,
            "date" => Self::Date,
            "person" => Self::Person,
            "checkbox" => Self::Checkbox,
            "link" => Self::Link,
            "email" => Self::Email,
            "phone" => Self::Phone,
            "image" => Self::Image,
            "attachment" => Self::Attachment,
            _ => return None,
        })
    }
}

/// 边车解码：坏了按无类型处理，不为此打不开表。
pub(crate) fn decode_kinds(raw: Option<&str>) -> Vec<Option<SheetFieldKind>> {
    let Some(raw) = raw else {
        return Vec::new();
    };
    let values: Vec<Option<serde_json::Value>> = serde_json::from_str(raw).unwrap_or_default();

    values
        .into_iter()
        .map(|value| match value {
            Some(serde_json::Value::String(name)) => SheetFieldKind::named(&name),
            _ => None,
        })
        .collect()
}

/// 边车编码：全是未指定就不写文件，一份没动过类型的表旁边是干净的。
pub(crate) fn encode_kinds(kinds: &[Option<SheetFieldKind>]) -> Option<String> {
    if kinds.iter().all(Option::is_none) {
        return None;
    }

    serde_json::to_string(kinds).ok()
}

/// Excel 导出的 CSV 带 UTF-8 BOM，不剥掉它会长进第一个字段名里。
const BOM: char = '\u{feff}';

fn broken(error: &csv::Error) -> LibraryError {
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
            kinds: Vec::new(),
        });
    };
    let header: Vec<String> = first
        .map_err(|error| broken(&error))?
        .iter()
        .map(str::to_owned)
        .collect();
    let mut rows = Vec::new();

    for record in records {
        let mut row: Vec<String> = record
            .map_err(|error| broken(&error))?
            .iter()
            .map(str::to_owned)
            .collect();

        row.resize(header.len(), String::new());
        rows.push(row);
    }

    Ok(TableSheet {
        header,
        rows,
        kinds: Vec::new(),
    })
}

pub(crate) fn encode(sheet: &TableSheet) -> Result<String> {
    if sheet.header.is_empty() {
        return Ok(String::new());
    }

    let mut writer = csv::WriterBuilder::new()
        .has_headers(false)
        .from_writer(Vec::new());

    writer
        .write_record(&sheet.header)
        .map_err(|error| broken(&error))?;

    for row in &sheet.rows {
        let mut aligned = row.clone();

        aligned.resize(sheet.header.len(), String::new());
        writer
            .write_record(&aligned)
            .map_err(|error| broken(&error))?;
    }

    let bytes = writer
        .into_inner()
        .map_err(|error| LibraryError::Invalid(format!("表格写不出去：{error}")))?;

    String::from_utf8(bytes).map_err(|_| LibraryError::Invalid("表格不是 UTF-8。".to_owned()))
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        clippy::panic,
        reason = "fixture failures must fail the test"
    )]

    use super::{SheetFieldKind, decode_kinds, encode_kinds};

    /// named 与 serde rename_all 是同一张表，分叉时这个测试先响。
    #[test]
    fn every_kind_survives_a_sidecar_round_trip() {
        let kinds: Vec<Option<SheetFieldKind>> = [
            SheetFieldKind::Text,
            SheetFieldKind::Number,
            SheetFieldKind::Currency,
            SheetFieldKind::Select,
            SheetFieldKind::MultiSelect,
            SheetFieldKind::Date,
            SheetFieldKind::Person,
            SheetFieldKind::Checkbox,
            SheetFieldKind::Link,
            SheetFieldKind::Email,
            SheetFieldKind::Phone,
            SheetFieldKind::Image,
            SheetFieldKind::Attachment,
            SheetFieldKind::Text,
        ]
        .into_iter()
        .map(Some)
        .collect();
        let raw = encode_kinds(&kinds).expect("encode");

        assert_eq!(decode_kinds(Some(&raw)), kinds);
    }

    #[test]
    fn unknown_names_and_broken_sidecars_fall_back_to_unspecified() {
        assert_eq!(
            decode_kinds(Some(r#"["text","下个版本的新类型",null,42]"#)),
            vec![Some(SheetFieldKind::Text), None, None, None]
        );
        assert!(decode_kinds(Some("不是 json")).is_empty());
        assert!(decode_kinds(None).is_empty());
        assert!(encode_kinds(&[None, None]).is_none());
    }
}
