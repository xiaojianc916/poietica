mod file;

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use tempfile::NamedTempFile;
use walkdir::WalkDir;

const MAX_DOCUMENT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ENTRIES: usize = 20_000;

#[derive(Debug, thiserror::Error)]
pub enum LibraryError {
    #[error("资料已被外部修改；草稿未覆盖磁盘。请另存草稿后重新打开。")]
    Conflict,
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Content(String),
}

pub type Result<T> = std::result::Result<T, LibraryError>;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    pub path: String,
    pub folder: bool,
    pub name: String,
    pub parent: String,
    pub modified: Option<String>,
    pub bytes: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LibraryDocument {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LibraryCatalog {
    pub root: String,
    pub entries: Vec<LibraryEntry>,
}

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
        path: String,
        content: String,
    },
    Folder {
        path: String,
    },
    Trash {
        path: String,
        expected: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum LibraryReply {
    Catalog(LibraryCatalog),
    Document(LibraryDocument),
    Done,
}

#[derive(Debug)]
pub struct Vault {
    root: PathBuf,
}

impl Vault {
    pub fn open(root: &Path) -> Result<Self> {
        let root = root.canonicalize()?;
        if !root.is_dir() || root.to_str().is_none() {
            return Err(LibraryError::Invalid(
                "请选择可读取的 UTF-8 路径文件夹。".into(),
            ));
        }
        Ok(Self { root })
    }

    pub fn identity(&self) -> String {
        self.root.to_string_lossy().into_owned()
    }

    fn path(&self, relative: &str, creating: bool) -> Result<PathBuf> {
        let relative = Path::new(relative);
        if relative.as_os_str().is_empty() {
            return Err(LibraryError::Invalid("资料路径不能为空。".into()));
        }
        let mut result = self.root.clone();
        let components: Vec<_> = relative.components().collect();
        for (index, component) in components.iter().enumerate() {
            let Component::Normal(segment) = component else {
                return Err(LibraryError::Invalid("只允许资料库内的相对路径。".into()));
            };
            if segment.to_string_lossy().starts_with('.') {
                return Err(LibraryError::Invalid("不操作隐藏文件或目录。".into()));
            }
            result.push(segment);
            match fs::symlink_metadata(&result) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    return Err(LibraryError::Invalid("不操作符号链接。".into()));
                }
                Ok(_) => {}
                Err(error)
                    if creating
                        && index + 1 == components.len()
                        && error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        let parent = result
            .parent()
            .ok_or_else(|| LibraryError::Invalid("路径无父目录。".into()))?;
        if !parent.canonicalize()?.starts_with(&self.root) {
            return Err(LibraryError::Invalid("路径超出了资料库。".into()));
        }
        Ok(result)
    }

    fn note_path(&self, relative: &str, creating: bool) -> Result<PathBuf> {
        let path = self.path(relative, creating)?;
        let extension = path.extension().and_then(|value| value.to_str());
        if !extension.is_some_and(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "md" | "markdown" | "txt"
            )
        }) {
            return Err(LibraryError::Invalid(
                "此编辑器支持 .md、.markdown 与 .txt。".into(),
            ));
        }
        Ok(path)
    }

    fn read_at(path: &Path) -> Result<String> {
        if fs::metadata(path)?.len() > MAX_DOCUMENT_BYTES {
            return Err(LibraryError::Invalid(
                "文件超过 16 MiB 编辑上限，未读取或修改。".into(),
            ));
        }
        file::get_note_content(path).map_err(LibraryError::Content)
    }

    fn document(&self, path: &str) -> Result<LibraryDocument> {
        let absolute = self.note_path(path, false)?;
        Ok(LibraryDocument {
            path: path.to_owned(),
            content: Self::read_at(&absolute)?,
        })
    }

    pub fn catalog(&self, query: &str) -> Result<LibraryCatalog> {
        let mut entries = Vec::new();
        let needle = query.to_lowercase();
        let walker = WalkDir::new(&self.root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| {
                entry.depth() == 0 || !entry.file_name().to_string_lossy().starts_with('.')
            });
        for entry in walker {
            let entry = entry.map_err(|error| LibraryError::Content(error.to_string()))?;
            if entry.depth() == 0 || entry.file_type().is_symlink() {
                continue;
            }
            let relative = entry
                .path()
                .strip_prefix(&self.root)
                .map_err(|error| LibraryError::Invalid(error.to_string()))?;
            let path = relative
                .to_str()
                .ok_or_else(|| LibraryError::Invalid("资料库含非 UTF-8 文件名。".into()))?
                .to_owned();
            let folder = entry.file_type().is_dir();
            if !folder {
                let supported = entry
                    .path()
                    .extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| {
                        matches!(
                            value.to_ascii_lowercase().as_str(),
                            "md" | "markdown" | "txt"
                        )
                    });
                if !supported {
                    continue;
                }
                self.note_path(&path, false)?;
            }
            if !needle.is_empty()
                && !path.to_lowercase().contains(&needle)
                && (folder
                    || !Self::read_at(entry.path())?
                        .to_lowercase()
                        .contains(&needle))
            {
                continue;
            }
            let (modified, _, bytes) =
                file::read_file_metadata(entry.path()).map_err(LibraryError::Content)?;
            let name = entry
                .file_name()
                .to_str()
                .ok_or_else(|| LibraryError::Invalid("文件名不是 UTF-8。".into()))?
                .to_owned();
            let parent = relative
                .parent()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_owned();
            entries.push(LibraryEntry {
                path,
                folder,
                name,
                parent,
                modified: modified.map(|value| value.to_string()),
                bytes: bytes.to_string(),
            });
            if entries.len() > MAX_ENTRIES {
                return Err(LibraryError::Invalid(
                    "结果超过 20,000 项，请选择更具体的文件夹；未返回不完整目录。".into(),
                ));
            }
        }
        entries.sort_by(|a, b| b.folder.cmp(&a.folder).then(a.path.cmp(&b.path)));
        Ok(LibraryCatalog {
            root: self.identity(),
            entries,
        })
    }

    fn lock(&self) -> Result<File> {
        let path = self.root.join(".poietica-library.lock");
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(LibraryError::Invalid("锁路径不能是符号链接。".into()));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)?;
        lock.try_lock_exclusive()?;
        Ok(lock)
    }

    fn write(&self, path: &str, content: &str, expected: Option<&str>) -> Result<LibraryDocument> {
        if content.len() as u64 > MAX_DOCUMENT_BYTES {
            return Err(LibraryError::Invalid("内容超过 16 MiB 保存上限。".into()));
        }
        let _lock = self.lock()?;
        let target = self.note_path(path, expected.is_none())?;
        let parent = target
            .parent()
            .ok_or_else(|| LibraryError::Invalid("路径无父目录。".into()))?;
        let mut prepared = NamedTempFile::new_in(parent)?;
        if expected.is_some() {
            let permissions = fs::metadata(&target)?.permissions();
            if permissions.readonly() {
                return Err(LibraryError::Invalid("文件为只读，草稿未丢弃。".into()));
            }
            prepared.as_file().set_permissions(permissions)?;
        }
        prepared.write_all(content.as_bytes())?;
        prepared.as_file().sync_all()?;
        if let Some(expected) = expected {
            if !file::note_content_matches(&target, expected).map_err(LibraryError::Content)? {
                return Err(LibraryError::Conflict);
            }
            prepared
                .persist(&target)
                .map_err(|error| LibraryError::Io(error.error))?;
        } else {
            prepared
                .persist_noclobber(&target)
                .map_err(|error| LibraryError::Io(error.error))?;
        }
        Ok(LibraryDocument {
            path: path.to_owned(),
            content: content.to_owned(),
        })
    }

    pub fn execute(&self, request: LibraryRequest) -> Result<LibraryReply> {
        match request {
            LibraryRequest::List { query } => self.catalog(&query).map(LibraryReply::Catalog),
            LibraryRequest::Read { path } => self.document(&path).map(LibraryReply::Document),
            LibraryRequest::Save {
                path,
                expected,
                content,
            } => self
                .write(&path, &content, Some(&expected))
                .map(LibraryReply::Document),
            LibraryRequest::Create { path, content } => self
                .write(&path, &content, None)
                .map(LibraryReply::Document),
            LibraryRequest::Folder { path } => {
                let _lock = self.lock()?;
                fs::create_dir(self.path(&path, true)?)?;
                Ok(LibraryReply::Done)
            }
            LibraryRequest::Trash { path, expected } => {
                let _lock = self.lock()?;
                let absolute = self.note_path(&path, false)?;
                if !file::note_content_matches(&absolute, &expected)
                    .map_err(LibraryError::Content)?
                {
                    return Err(LibraryError::Conflict);
                }
                trash::delete(absolute)
                    .map_err(|error| LibraryError::Content(error.to_string()))?;
                Ok(LibraryReply::Done)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{LibraryReply, LibraryRequest, Vault};
    use std::fs;

    #[test]
    fn creates_reads_and_rejects_overwriting_existing_files()
    -> Result<(), Box<dyn std::error::Error>> {
        let root = tempfile::tempdir()?;
        let vault = Vault::open(root.path())?;
        vault.execute(LibraryRequest::Create {
            path: "笔记.md".into(),
            content: "正文".into(),
        })?;
        assert!(
            vault
                .execute(LibraryRequest::Create {
                    path: "笔记.md".into(),
                    content: "覆盖".into()
                })
                .is_err()
        );
        assert_eq!(fs::read_to_string(root.path().join("笔记.md"))?, "正文");
        assert!(matches!(
            vault.execute(LibraryRequest::Read {
                path: "笔记.md".into()
            })?,
            LibraryReply::Document(_)
        ));
        Ok(())
    }

    #[test]
    fn external_changes_reject_stale_save_without_losing_either_version()
    -> Result<(), Box<dyn std::error::Error>> {
        let root = tempfile::tempdir()?;
        let vault = Vault::open(root.path())?;
        fs::write(root.path().join("note.md"), "outside")?;
        assert!(
            vault
                .execute(LibraryRequest::Save {
                    path: "note.md".into(),
                    expected: "before".into(),
                    content: "draft".into()
                })
                .is_err()
        );
        assert_eq!(fs::read_to_string(root.path().join("note.md"))?, "outside");
        Ok(())
    }

    #[test]
    fn rejects_traversal_and_searches_multibyte_content() -> Result<(), Box<dyn std::error::Error>>
    {
        let root = tempfile::tempdir()?;
        let vault = Vault::open(root.path())?;
        assert!(
            vault
                .execute(LibraryRequest::Read {
                    path: "../outside.md".into()
                })
                .is_err()
        );
        fs::write(root.path().join("note.md"), "汉字🧭")?;
        assert_eq!(vault.catalog("汉字")?.entries.len(), 1);
        assert!(vault.catalog("missing")?.entries.is_empty());
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_symbolic_links() -> Result<(), Box<dyn std::error::Error>> {
        let root = tempfile::tempdir()?;
        let outside = tempfile::tempdir()?;
        fs::write(outside.path().join("secret.md"), "secret")?;
        std::os::unix::fs::symlink(outside.path(), root.path().join("escape"))?;
        let vault = Vault::open(root.path())?;
        assert!(
            vault
                .execute(LibraryRequest::Read {
                    path: "escape/secret.md".into()
                })
                .is_err()
        );
        assert!(vault.catalog("")?.entries.is_empty());
        Ok(())
    }
}
