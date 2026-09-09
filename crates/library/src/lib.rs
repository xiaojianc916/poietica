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

/// 单份资料的读写上限。
const MAX_DOCUMENT_BYTES: u64 = 16 * 1024 * 1024;

/// 目录规模上限，同时是同名去重的尝试次数上限。
const MAX_ENTRIES: usize = 20_000;
const LOCK_FILE: &str = ".poietica-library.lock";
const UNTITLED_FOLDER: &str = "未命名文件夹";

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
    const fn spec(self) -> (&'static str, &'static str) {
        match self {
            Self::Markdown => ("md", "未命名文档"),
            Self::Table => ("csv", "未命名表格"),
            Self::Page => ("html", "未命名网页"),
        }
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

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LibraryDocument {
    pub path: String,
    pub content: String,
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
        content: String,
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
                content,
            } => self
                .write(&path, &content, &expected)
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

    fn document(&self, path: &str) -> Result<LibraryDocument> {
        let target = self.file(path)?;

        Ok(LibraryDocument {
            path: path.to_owned(),
            content: read_text(&target)?,
        })
    }

    /// 先写临时文件再比对现状最后原子替换：写失败不会留下半份文件。
    fn write(&self, path: &str, content: &str, expected: &str) -> Result<LibraryDocument> {
        if content.len() as u64 > MAX_DOCUMENT_BYTES {
            return Err(LibraryError::Invalid(
                "内容超过 16 MiB，未写入。".to_owned(),
            ));
        }

        let _lock = self.lock()?;
        let target = self.file(path)?;
        let holder = target
            .parent()
            .ok_or_else(|| LibraryError::Invalid("资料没有父目录。".to_owned()))?;
        let permissions = fs::metadata(&target)?.permissions();

        if permissions.readonly() {
            return Err(LibraryError::Invalid("资料是只读的，未写入。".to_owned()));
        }

        let mut prepared = NamedTempFile::new_in(holder)?;

        prepared.as_file().set_permissions(permissions)?;
        prepared.write_all(content.as_bytes())?;
        prepared.as_file().sync_all()?;

        if fs::read(&target)? != expected.as_bytes() {
            return Err(LibraryError::Conflict);
        }

        prepared
            .persist(&target)
            .map_err(|error| LibraryError::Io(error.error))?;

        Ok(LibraryDocument {
            path: path.to_owned(),
            content: content.to_owned(),
        })
    }

    fn create(&self, parent: &str, format: LibraryFormat) -> Result<String> {
        let _lock = self.lock()?;
        let holder = self.directory(parent)?;
        let target = vacancy(&holder, format.untitled(), Some(format.extension()))?;

        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)?;

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
        self.relative(&target)
    }

    /// 进系统回收站，文件与文件夹同一条路径。
    fn trash(&self, path: &str) -> Result<()> {
        let _lock = self.lock()?;
        let target = self.path(path, false)?;

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

    fn file(&self, relative: &str) -> Result<PathBuf> {
        let resolved = self.path(relative, false)?;

        if LibraryFormat::of(&resolved).is_none() || !resolved.is_file() {
            return Err(LibraryError::Invalid("这不是一份资料文件。".to_owned()));
        }

        Ok(resolved)
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

/// 一份资料的正文。三种格式都是文本格式，所以只接 UTF-8。
fn read_text(path: &Path) -> Result<String> {
    let metadata = fs::metadata(path)?;

    if metadata.len() > MAX_DOCUMENT_BYTES {
        return Err(LibraryError::Invalid(
            "资料超过 16 MiB，未读取。".to_owned(),
        ));
    }

    String::from_utf8(fs::read(path)?)
        .map_err(|_| LibraryError::Invalid("资料不是 UTF-8 文本。".to_owned()))
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        clippy::panic,
        reason = "fixture failures must fail the test"
    )]

    use super::{LibraryError, LibraryFormat, LibraryReply, LibraryRequest, Vault};
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
                content: "我写的".to_owned(),
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
}
