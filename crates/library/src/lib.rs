//! 资料库：应用自己拥有的一块磁盘空间。
//!
//! 根由宿主给出（apps/desktop/src-tauri/src/paths.rs），本 crate 不认识 Tauri，
//! 也不接受库外路径：它只在根之内做树操作。

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;
use tempfile::NamedTempFile;
use walkdir::WalkDir;

mod table;

pub use table::{SheetFieldKind, TableSheet};

/// 单份资料的读写上限。
const MAX_DOCUMENT_BYTES: u64 = 16 * 1024 * 1024;

/// 目录规模上限，同时是同名去重的尝试次数上限。
const MAX_ENTRIES: usize = 20_000;
const LOCK_FILE: &str = ".poietica-library.lock";
const UNTITLED_FOLDER: &str = "未命名文件夹";
/// 新建表格落盘的初始表：空文件不是表，打开就得是一张可用的表。
/// 列名即列类型，种子边车跟着写一份，见 create。
const TABLE_SEED: &str = "标题,数字,单选,日期\n,,,\n,,,\n,,,\n,,,\n,,,\n";
/// 新建表格的初始列类型，与 TABLE_SEED 的列名一一对应。
const TABLE_SEED_KINDS: [SheetFieldKind; 4] = [
    SheetFieldKind::Text,
    SheetFieldKind::Number,
    SheetFieldKind::Select,
    SheetFieldKind::Date,
];

#[derive(Debug, thiserror::Error)]
pub enum LibraryError {
    #[error("资料已被改动，未写入。")]
    Conflict,
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, LibraryError>;

/// 资料库认识的文件种类。扩展名与新建默认名只在 spec 里写一次。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LibraryFormat {
    Markdown,
    Table,
    Page,
}

impl LibraryFormat {
    const ALL: [Self; 3] = [Self::Markdown, Self::Table, Self::Page];

    /// 加一种格式：加 variant（编译器逼你补齐这里）并加进 ALL。
    const fn spec(self) -> (&'static str, &'static str, &'static str) {
        match self {
            Self::Markdown => ("md", "未命名文档", ""),
            Self::Table => ("csv", "未命名表格", TABLE_SEED),
            Self::Page => ("html", "未命名网页", ""),
        }
    }

    /// 新建时写进去的初始内容。
    const fn seed(self) -> &'static str {
        self.spec().2
    }

    /// 导入过滤器与目录识别用同一份扩展名，不在宿主侧再抄一遍。
    #[must_use]
    pub fn extensions() -> [&'static str; 3] {
        Self::ALL.map(Self::extension)
    }

    #[must_use]
    pub const fn extension(self) -> &'static str {
        self.spec().0
    }

    const fn untitled(self) -> &'static str {
        self.spec().1
    }

    /// 认扩展名：库里的名字都由本 crate 落下。
    #[must_use]
    pub fn of(path: &Path) -> Option<Self> {
        let extension = path.extension()?.to_str()?.to_ascii_lowercase();

        Self::ALL
            .into_iter()
            .find(|format| format.extension() == extension)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    /// 相对根的路径，也是这一行的身份。
    pub path: String,
    pub name: String,
    pub parent: String,
    /// None 即文件夹：种类与「是不是文件夹」是同一个判别式。
    pub format: Option<LibraryFormat>,
    /// 修改时间，Unix 秒。字符串是为了过 IPC 不被 f64 削精度。
    pub modified: Option<String>,
    pub bytes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LibraryCatalog {
    pub entries: Vec<LibraryEntry>,
}

/// 一份资料的正文。变体与文件种类一一对应，判别式只有这一个。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum LibraryBody {
    Markdown(String),
    Table(TableSheet),
    Page(String),
}

impl LibraryBody {
    fn format(&self) -> LibraryFormat {
        match self {
            Self::Markdown(_) => LibraryFormat::Markdown,
            Self::Table(_) => LibraryFormat::Table,
            Self::Page(_) => LibraryFormat::Page,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LibraryDocument {
    pub path: String,
    /// 落盘字节的指纹。保存时带回来做乐观并发比对，语义同 HTTP ETag。
    pub version: String,
    pub body: LibraryBody,
}

/// 渲染层能发出的全部请求。库外路径不在其中：导入的源文件由宿主的
/// 文件选择器给出，渲染层无从指定库外的任何一个位置。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LibraryRequest {
    List {
        query: String,
    },
    Read {
        path: String,
    },
    Save {
        path: String,
        expected: String,
        body: LibraryBody,
    },
    Create {
        parent: String,
        format: LibraryFormat,
    },
    Folder {
        parent: String,
    },
    Rename {
        path: String,
        name: String,
    },
    Trash {
        path: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum LibraryReply {
    Catalog(LibraryCatalog),
    Document(LibraryDocument),
    /// 新建、导入与重命名之后条目的落点，供界面选中它。
    Placed(String),
    Done,
}

/// 一块资料库空间。持有根路径，所有操作锁在根之内。
#[derive(Debug)]
pub struct Vault {
    root: PathBuf,
}

impl Vault {
    /// # Errors
    ///
    /// 根路径无法规范化或不是目录时返回错误。
    pub fn open(root: &Path) -> Result<Self> {
        let root = root.canonicalize()?;

        if !root.is_dir() {
            return Err(LibraryError::Invalid("资料库根不是目录。".to_owned()));
        }

        Ok(Self { root })
    }

    /// 唯一分发点。
    ///
    /// # Errors
    ///
    /// 请求越界、目标不存在、或磁盘操作失败时返回错误。
    pub fn execute(&self, request: LibraryRequest) -> Result<LibraryReply> {
        match request {
            LibraryRequest::List { query } => self.catalog(&query).map(LibraryReply::Catalog),
            LibraryRequest::Read { path } => self.document(&path).map(LibraryReply::Document),
            LibraryRequest::Save {
                path,
                expected,
                body,
            } => self
                .write(&path, &body, &expected)
                .map(LibraryReply::Document),
            LibraryRequest::Create { parent, format } => {
                self.create(&parent, format).map(LibraryReply::Placed)
            }
            LibraryRequest::Folder { parent } => self.folder(&parent).map(LibraryReply::Placed),
            LibraryRequest::Rename { path, name } => {
                self.rename(&path, name.trim()).map(LibraryReply::Placed)
            }
            LibraryRequest::Trash { path } => self.trash(&path).map(|()| LibraryReply::Done),
        }
    }

    /// 把库外的一份文件复制进来。按字节复制，不经文本解码。
    ///
    /// # Errors
    ///
    /// 源文件不是三种格式、不是普通文件、超过上限或复制失败时返回错误。
    pub fn import(&self, parent: &str, source: &Path) -> Result<String> {
        let format = LibraryFormat::of(source).ok_or_else(|| {
            LibraryError::Invalid("只支持导入 .md、.csv 与 .html 文件。".to_owned())
        })?;
        let metadata = fs::symlink_metadata(source)?;

        if !metadata.is_file() {
            return Err(LibraryError::Invalid("只能导入普通文件。".to_owned()));
        }
        if metadata.len() > MAX_DOCUMENT_BYTES {
            return Err(LibraryError::Invalid(
                "文件超过 16 MiB，未导入。".to_owned(),
            ));
        }

        let _lock = self.lock()?;
        let holder = self.directory(parent)?;
        let stem = source
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.starts_with('.'))
            .unwrap_or(format.untitled());
        let target = vacancy(&holder, stem, Some(format.extension()))?;

        fs::copy(source, &target)?;
        self.relative(&target)
    }

    fn catalog(&self, query: &str) -> Result<LibraryCatalog> {
        let needle = query.trim().to_lowercase();
        let mut entries = Vec::new();
        let walker = WalkDir::new(&self.root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| {
                entry.depth() == 0 || !entry.file_name().to_string_lossy().starts_with('.')
            });

        for entry in walker {
            let entry = entry.map_err(|error| LibraryError::Invalid(error.to_string()))?;

            if entry.depth() == 0 || entry.file_type().is_symlink() {
                continue;
            }

            let relative = entry
                .path()
                .strip_prefix(&self.root)
                .map_err(|error| LibraryError::Invalid(error.to_string()))?;
            let path = relative
                .to_str()
                .ok_or_else(|| LibraryError::Invalid("资料名不是 UTF-8。".to_owned()))?;
            let format = if entry.file_type().is_dir() {
                None
            } else if let Some(format) = LibraryFormat::of(entry.path()) {
                Some(format)
            } else {
                continue;
            };

            if !needle.is_empty() && !matches(entry.path(), path, format.is_some(), &needle) {
                continue;
            }
            if entries.len() >= MAX_ENTRIES {
                return Err(LibraryError::Invalid(
                    "资料条目过多，请整理后再打开。".to_owned(),
                ));
            }

            let metadata = fs::metadata(entry.path())?;

            entries.push(LibraryEntry {
                path: path.to_owned(),
                name: relative
                    .file_name()
                    .map_or_else(String::new, |value| value.to_string_lossy().into_owned()),
                parent: relative
                    .parent()
                    .and_then(Path::to_str)
                    .unwrap_or_default()
                    .to_owned(),
                format,
                modified: metadata
                    .modified()
                    .ok()
                    .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                    .map(|value| value.as_secs().to_string()),
                bytes: metadata.len().to_string(),
            });
        }

        entries.sort_by(|left, right| {
            right
                .format
                .is_none()
                .cmp(&left.format.is_none())
                .then_with(|| left.name.cmp(&right.name))
        });

        Ok(LibraryCatalog { entries })
    }

    /// 种类决定正文形状，这个映射只在这里做一次。
    fn document(&self, path: &str) -> Result<LibraryDocument> {
        let (target, format) = self.file(path)?;
        let bytes = read_bytes(&target)?;
        let schema = match format {
            LibraryFormat::Table => read_schema(&target)?,
            _ => None,
        };
        let version = fingerprint_doc(&bytes, schema.as_deref().unwrap_or_default().as_bytes());
        let text = decode_text(bytes)?;

        Ok(LibraryDocument {
            path: path.to_owned(),
            version,
            body: match format {
                LibraryFormat::Markdown => LibraryBody::Markdown(text),
                LibraryFormat::Table => LibraryBody::Table(decode_sheet(&text, schema.as_deref())?),
                LibraryFormat::Page => LibraryBody::Page(text),
            },
        })
    }

    /// 先写临时文件再比对指纹最后原子替换：写失败不会留下半份文件。
    /// 指纹叠加边车：只改列类型也算改动，顶掉别人的类型改动要报冲突。
    fn write(&self, path: &str, body: &LibraryBody, expected: &str) -> Result<LibraryDocument> {
        let _lock = self.lock()?;
        let (target, format) = self.file(path)?;
        let content = serialize(format, body)?;
        let schema = match body {
            LibraryBody::Table(sheet) => table::encode_kinds(&sheet.kinds),
            _ => None,
        };
        let holder = target
            .parent()
            .ok_or_else(|| LibraryError::Invalid("资料没有父目录。".to_owned()))?;
        let permissions = fs::metadata(&target)?.permissions();

        if permissions.readonly() {
            return Err(LibraryError::Invalid("资料是只读的，未写入。".to_owned()));
        }

        let current = read_bytes(&target)?;
        let current_schema = match format {
            LibraryFormat::Table => read_schema(&target)?.unwrap_or_default(),
            _ => String::new(),
        };

        if fingerprint_doc(&current, current_schema.as_bytes()) != expected {
            return Err(LibraryError::Conflict);
        }

        let mut prepared = NamedTempFile::new_in(holder)?;

        prepared.as_file().set_permissions(permissions)?;
        prepared.write_all(content.as_bytes())?;
        prepared.as_file().sync_all()?;
        prepared
            .persist(&target)
            .map_err(|error| LibraryError::Io(error.error))?;
        write_schema(&target, schema.as_deref())?;

        Ok(LibraryDocument {
            path: path.to_owned(),
            version: fingerprint_doc(
                content.as_bytes(),
                schema.as_deref().unwrap_or_default().as_bytes(),
            ),
            body: match body {
                LibraryBody::Markdown(_) => LibraryBody::Markdown(content),
                LibraryBody::Page(_) => LibraryBody::Page(content),
                LibraryBody::Table(_) => {
                    LibraryBody::Table(decode_sheet(&content, schema.as_deref())?)
                }
            },
        })
    }

    fn create(&self, parent: &str, format: LibraryFormat) -> Result<String> {
        let _lock = self.lock()?;
        let holder = self.directory(parent)?;
        let target = vacancy(&holder, format.untitled(), Some(format.extension()))?;

        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)?
            .write_all(format.seed().as_bytes())?;

        if format == LibraryFormat::Table {
            let seed: Vec<Option<SheetFieldKind>> =
                TABLE_SEED_KINDS.iter().map(|kind| Some(*kind)).collect();

            if let Some(text) = table::encode_kinds(&seed) {
                fs::write(schema_path(&target), text)?;
            }
        }

        self.relative(&target)
    }

    fn folder(&self, parent: &str) -> Result<String> {
        let _lock = self.lock()?;
        let holder = self.directory(parent)?;
        let target = vacancy(&holder, UNTITLED_FOLDER, None)?;

        fs::create_dir(&target)?;
        self.relative(&target)
    }

    fn rename(&self, path: &str, name: &str) -> Result<String> {
        if Path::new(name).components().count() != 1 {
            return Err(LibraryError::Invalid(
                "名称不能为空，也不能包含路径分隔符。".to_owned(),
            ));
        }

        let _lock = self.lock()?;
        let source = self.path(path, false)?;
        let holder = Path::new(path)
            .parent()
            .and_then(Path::to_str)
            .unwrap_or_default();
        let sibling = if holder.is_empty() {
            name.to_owned()
        } else {
            format!("{holder}/{name}")
        };
        let target = self.path(&sibling, true)?;

        if target == source {
            return Ok(path.to_owned());
        }
        if source.is_file() && LibraryFormat::of(&target) != LibraryFormat::of(&source) {
            return Err(LibraryError::Invalid("重命名不能改变资料类型。".to_owned()));
        }
        if target.exists() {
            return Err(LibraryError::Invalid("同名条目已存在。".to_owned()));
        }

        fs::rename(&source, &target)?;

        if LibraryFormat::of(&source) == Some(LibraryFormat::Table) {
            match fs::rename(schema_path(&source), schema_path(&target)) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                other => {
                    other?;
                }
            }
        }

        self.relative(&target)
    }

    /// 进系统回收站，文件与文件夹同一条路径。表格先清边车：主文件已经进了
    /// 回收站，边车再留着就是一份永远对不上的孤儿。
    fn trash(&self, path: &str) -> Result<()> {
        let _lock = self.lock()?;
        let target = self.path(path, false)?;

        if LibraryFormat::of(&target) == Some(LibraryFormat::Table) {
            match fs::remove_file(schema_path(&target)) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                other => {
                    other?;
                }
            }
        }

        trash::delete(target).map_err(|error| LibraryError::Invalid(error.to_string()))
    }

    /// 唯一的路径解析点：越界、隐藏文件、软链接都在这里被拒。
    fn path(&self, relative: &str, allow_missing: bool) -> Result<PathBuf> {
        if relative.is_empty() {
            return Err(LibraryError::Invalid("路径不能为空。".to_owned()));
        }

        let mut resolved = self.root.clone();

        for component in Path::new(relative).components() {
            let Component::Normal(part) = component else {
                return Err(LibraryError::Invalid(
                    "只接受资料库内的相对路径。".to_owned(),
                ));
            };

            if part.to_string_lossy().starts_with('.') {
                return Err(LibraryError::Invalid("不接受以点开头的名字。".to_owned()));
            }

            resolved.push(part);

            match fs::symlink_metadata(&resolved) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    return Err(LibraryError::Invalid("不跟随软链接。".to_owned()));
                }
                Ok(_) => {}
                Err(error) if allow_missing && error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(LibraryError::Io(error)),
            }
        }

        Ok(resolved)
    }

    /// 资料文件连同它的种类：种类是正文形状的唯一判据，不在调用点二次判断。
    fn file(&self, relative: &str) -> Result<(PathBuf, LibraryFormat)> {
        let resolved = self.path(relative, false)?;

        match LibraryFormat::of(&resolved) {
            Some(format) if resolved.is_file() => Ok((resolved, format)),
            _ => Err(LibraryError::Invalid("这不是一份资料文件。".to_owned())),
        }
    }

    /// 落点目录。空串就是根。
    fn directory(&self, relative: &str) -> Result<PathBuf> {
        if relative.is_empty() {
            return Ok(self.root.clone());
        }

        let resolved = self.path(relative, false)?;

        if !resolved.is_dir() {
            return Err(LibraryError::Invalid(
                "落点不是资料库里的文件夹。".to_owned(),
            ));
        }

        Ok(resolved)
    }

    fn relative(&self, target: &Path) -> Result<String> {
        target
            .strip_prefix(&self.root)
            .ok()
            .and_then(Path::to_str)
            .map(str::to_owned)
            .ok_or_else(|| LibraryError::Invalid("落点不在资料库内。".to_owned()))
    }

    /// 一把跳过进程的排他锁，所有写操作都从它下面走。
    fn lock(&self) -> Result<File> {
        let handle = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(self.root.join(LOCK_FILE))?;

        handle.lock_exclusive()?;

        Ok(handle)
    }
}

/// 名字命中即算命中；只有文件才继续读正文。读不出文本的文件不参与正文匹配：
/// 一次检索不该被一个坏文件打断。
fn matches(absolute: &Path, path: &str, readable: bool, needle: &str) -> bool {
    if path.to_lowercase().contains(needle) {
        return true;
    }

    readable && read_text(absolute).is_ok_and(|text| text.to_lowercase().contains(needle))
}

/// 「未命名文档」「未命名文档 2」…… 在 holder 下找第一个空位。
fn vacancy(holder: &Path, stem: &str, extension: Option<&str>) -> Result<PathBuf> {
    for attempt in 1..=MAX_ENTRIES {
        let stem = if attempt == 1 {
            stem.to_owned()
        } else {
            format!("{stem} {attempt}")
        };
        let name = match extension {
            Some(extension) => format!("{stem}.{extension}"),
            None => stem,
        };
        let candidate = holder.join(name);

        if !candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(LibraryError::Invalid("同名条目过多，未新建。".to_owned()))
}

/// 边车文件名：表.csv → 表.schema.json。json 不在资料种类里，目录与搜索自然无视它。
fn schema_path(target: &Path) -> PathBuf {
    target.with_extension("schema.json")
}

/// 边车缺席是常态（老文件、导入的文件），只有其它读错误才算错。
fn read_schema(target: &Path) -> Result<Option<String>> {
    match fs::read_to_string(schema_path(target)) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(LibraryError::Io(error)),
    }
}

/// 边车与主文件同一次落盘。None 表示没有指定的类型，旧边车顺手清掉。
fn write_schema(target: &Path, schema: Option<&str>) -> Result<()> {
    let path = schema_path(target);

    match schema {
        Some(text) => {
            let holder = path
                .parent()
                .ok_or_else(|| LibraryError::Invalid("资料没有父目录。".to_owned()))?;
            let mut prepared = NamedTempFile::new_in(holder)?;

            if let Ok(permissions) = fs::metadata(&path).map(|metadata| metadata.permissions()) {
                prepared.as_file().set_permissions(permissions)?;
            }

            prepared.write_all(text.as_bytes())?;
            prepared.as_file().sync_all()?;
            prepared
                .persist(&path)
                .map_err(|error| LibraryError::Io(error.error))?;
            Ok(())
        }
        None => match fs::remove_file(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => other.map_err(LibraryError::Io),
        },
    }
}

/// CSV 解码后再把边车的类型按列对上：外部改过表头时多退少补，不报错。
fn decode_sheet(text: &str, schema: Option<&str>) -> Result<TableSheet> {
    let mut sheet = table::decode(text)?;
    let mut kinds = table::decode_kinds(schema);

    kinds.resize(sheet.header.len(), None);
    sheet.kinds = kinds;

    Ok(sheet)
}

/// 落盘内容的指纹。乐观并发只需要「变没变」，blake3 已在本工作区，不再引第二套摘要。
/// 边车也在指纹里：只改列类型也算一次改动。
fn fingerprint_doc(csv: &[u8], schema: &[u8]) -> String {
    let mut hasher = blake3::Hasher::new();

    for part in [csv, schema] {
        hasher.update(&(part.len() as u64).to_le_bytes());
        hasher.update(part);
    }

    hasher.finalize().to_hex().to_string()
}

fn read_bytes(path: &Path) -> Result<Vec<u8>> {
    let metadata = fs::metadata(path)?;

    if metadata.len() > MAX_DOCUMENT_BYTES {
        return Err(LibraryError::Invalid(
            "资料超过 16 MiB，未读取。".to_owned(),
        ));
    }

    Ok(fs::read(path)?)
}

/// 三种格式都是文本格式，所以只接 UTF-8。
fn decode_text(bytes: Vec<u8>) -> Result<String> {
    String::from_utf8(bytes).map_err(|_| LibraryError::Invalid("资料不是 UTF-8 文本。".to_owned()))
}

fn read_text(path: &Path) -> Result<String> {
    decode_text(read_bytes(path)?)
}

/// 正文形状必须与资料种类相符，序列化只在这里做一次。
fn serialize(format: LibraryFormat, body: &LibraryBody) -> Result<String> {
    if body.format() != format {
        return Err(LibraryError::Invalid("正文形状与资料种类不符。".to_owned()));
    }

    let content = match body {
        LibraryBody::Markdown(text) | LibraryBody::Page(text) => text.clone(),
        LibraryBody::Table(sheet) => table::encode(sheet)?,
    };

    if content.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err(LibraryError::Invalid(
            "内容超过 16 MiB，未写入。".to_owned(),
        ));
    }

    Ok(content)
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing,
        reason = "fixture failures must fail the test"
    )]

    use super::{
        LibraryBody, LibraryError, LibraryFormat, LibraryReply, LibraryRequest, SheetFieldKind,
        TableSheet, Vault,
    };
    use std::fs;

    fn vault() -> (tempfile::TempDir, Vault) {
        let home = tempfile::tempdir().expect("temp dir");
        let vault = Vault::open(home.path()).expect("open vault");

        (home, vault)
    }

    fn placed(reply: LibraryReply) -> String {
        match reply {
            LibraryReply::Placed(path) => path,
            other => panic!("expected a placement, got {other:?}"),
        }
    }

    fn note(vault: &Vault) -> String {
        placed(
            vault
                .execute(LibraryRequest::Create {
                    parent: String::new(),
                    format: LibraryFormat::Markdown,
                })
                .expect("create"),
        )
    }

    fn table(vault: &Vault) -> String {
        placed(
            vault
                .execute(LibraryRequest::Create {
                    parent: String::new(),
                    format: LibraryFormat::Table,
                })
                .expect("create table"),
        )
    }

    fn read(vault: &Vault, path: &str) -> super::LibraryDocument {
        match vault
            .execute(LibraryRequest::Read {
                path: path.to_owned(),
            })
            .expect("read")
        {
            LibraryReply::Document(document) => document,
            other => panic!("expected a document, got {other:?}"),
        }
    }

    fn sheet_of(document: &super::LibraryDocument) -> TableSheet {
        match &document.body {
            LibraryBody::Table(sheet) => sheet.clone(),
            other => panic!("expected a table, got {other:?}"),
        }
    }

    #[test]
    fn creating_twice_never_overwrites() {
        let (_home, vault) = vault();

        assert_eq!(note(&vault), "未命名文档.md");
        assert_eq!(note(&vault), "未命名文档 2.md");
    }

    #[test]
    fn import_copies_bytes_without_decoding() {
        let (home, vault) = vault();
        let elsewhere = tempfile::tempdir().expect("temp dir");
        let source = elsewhere.path().join("表.CSV");

        fs::write(&source, [0xff_u8, 0xfe]).expect("write source");

        let path = vault.import("", &source).expect("import");

        assert_eq!(path, "表.csv");
        assert_eq!(
            fs::read(home.path().join(&path)).expect("read copy"),
            [0xff_u8, 0xfe]
        );
    }

    #[test]
    fn other_extensions_are_invisible_and_unimportable() {
        let (home, vault) = vault();

        fs::write(home.path().join("笔记.txt"), "旧").expect("write");

        let LibraryReply::Catalog(catalog) = vault
            .execute(LibraryRequest::List {
                query: String::new(),
            })
            .expect("list")
        else {
            panic!("expected a catalog")
        };

        assert!(catalog.entries.is_empty());
        assert!(matches!(
            vault.import("", &home.path().join("笔记.txt")),
            Err(LibraryError::Invalid(_))
        ));
    }

    #[test]
    fn escaping_the_root_is_refused() {
        let (_home, vault) = vault();

        for path in ["../外面.md", ".隐藏.md"] {
            assert!(matches!(
                vault.execute(LibraryRequest::Read {
                    path: path.to_owned()
                }),
                Err(LibraryError::Invalid(_))
            ));
        }
    }

    #[test]
    fn saving_over_a_changed_file_reports_conflict() {
        let (home, vault) = vault();
        let path = note(&vault);

        fs::write(home.path().join(&path), "别人写的").expect("write");

        assert!(matches!(
            vault.execute(LibraryRequest::Save {
                path,
                expected: String::new(),
                body: LibraryBody::Markdown("我写的".to_owned()),
            }),
            Err(LibraryError::Conflict)
        ));
    }

    #[test]
    fn renaming_keeps_the_format() {
        let (_home, vault) = vault();
        let path = note(&vault);

        assert_eq!(
            placed(
                vault
                    .execute(LibraryRequest::Rename {
                        path,
                        name: "读书笔记.md".to_owned(),
                    })
                    .expect("rename")
            ),
            "读书笔记.md"
        );
        assert!(matches!(
            vault.execute(LibraryRequest::Rename {
                path: "读书笔记.md".to_owned(),
                name: "读书笔记.txt".to_owned(),
            }),
            Err(LibraryError::Invalid(_))
        ));
    }

    #[test]
    fn fresh_tables_carry_seed_kinds_and_survive_a_save() {
        let (_home, vault) = vault();
        let path = table(&vault);
        let opened = read(&vault, &path);

        assert_eq!(
            sheet_of(&opened).kinds,
            [
                SheetFieldKind::Text,
                SheetFieldKind::Number,
                SheetFieldKind::Select,
                SheetFieldKind::Date,
            ]
            .into_iter()
            .map(Some)
            .collect::<Vec<_>>()
        );

        let mut sheet = sheet_of(&opened);

        sheet.kinds = vec![Some(SheetFieldKind::Currency), None, None, None];

        let LibraryReply::Document(saved) = vault
            .execute(LibraryRequest::Save {
                path: path.clone(),
                expected: opened.version.clone(),
                body: LibraryBody::Table(sheet),
            })
            .expect("save")
        else {
            panic!("expected a document")
        };

        assert_ne!(saved.version, opened.version);
        assert_eq!(sheet_of(&saved).kinds[0], Some(SheetFieldKind::Currency));
        assert_eq!(
            sheet_of(&read(&vault, &path)).kinds[0],
            Some(SheetFieldKind::Currency)
        );
    }

    #[test]
    fn tables_without_a_schema_fall_back_to_unspecified() {
        let (home, vault) = vault();

        fs::write(home.path().join("外部.csv"), "甲,乙\n1,2\n").expect("write source");

        let opened = read(&vault, "外部.csv");

        assert_eq!(sheet_of(&opened).kinds, vec![None, None]);
    }

    #[test]
    fn renaming_a_table_moves_its_schema_and_trashing_cleans_it() {
        let (home, vault) = vault();
        let path = table(&vault);

        assert!(home.path().join("未命名表格.schema.json").exists());

        let moved = placed(
            vault
                .execute(LibraryRequest::Rename {
                    path,
                    name: "改名.csv".to_owned(),
                })
                .expect("rename"),
        );

        assert_eq!(moved, "改名.csv");
        assert!(!home.path().join("未命名表格.schema.json").exists());
        assert!(home.path().join("改名.schema.json").exists());

        vault
            .execute(LibraryRequest::Trash { path: moved })
            .expect("trash");

        assert!(!home.path().join("改名.csv").exists());
        assert!(!home.path().join("改名.schema.json").exists());
    }
}
