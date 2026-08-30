use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use tempfile::NamedTempFile;
use thiserror::Error;

const MAX_DOCUMENT_BYTES: u64 = 512 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CustomAgentFile {
    pub relative_path: String,
    pub absolute_path: PathBuf,
    pub document: String,
}

#[derive(Debug, Default, Eq, PartialEq)]
pub struct CustomAgentCatalog {
    pub files: Vec<CustomAgentFile>,
    pub issues: Vec<String>,
}

#[derive(Debug, Error)]
pub enum CustomAgentFileError {
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("agent file changed outside this editor")]
    Conflict,
}

pub fn list_custom_agents(root: &Path) -> Result<CustomAgentCatalog, CustomAgentFileError> {
    fs::create_dir_all(root)?;
    let mut catalog = CustomAgentCatalog::default();
    visit(root, root, &mut catalog)?;
    catalog
        .files
        .sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(catalog)
}

pub fn save_custom_agent(
    root: &Path,
    relative_path: &str,
    document: &str,
    expected_document: Option<&str>,
) -> Result<CustomAgentFile, CustomAgentFileError> {
    if document.trim().is_empty() {
        return Err(CustomAgentFileError::Invalid(
            "agent document must not be empty".to_owned(),
        ));
    }
    if document.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err(CustomAgentFileError::Invalid(
            "agent document is larger than 512 KiB".to_owned(),
        ));
    }

    fs::create_dir_all(root)?;
    let target = resolve_file(root, relative_path)?;
    compare_current(&target, expected_document)?;

    let parent = target.parent().ok_or_else(|| {
        CustomAgentFileError::Invalid("agent file has no parent directory".to_owned())
    })?;
    let mut temporary = NamedTempFile::new_in(parent)?;
    temporary.write_all(document.as_bytes())?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(&target)
        .map_err(|failure| CustomAgentFileError::Io(failure.error))?;

    Ok(CustomAgentFile {
        relative_path: relative_path.to_owned(),
        absolute_path: target,
        document: document.to_owned(),
    })
}

pub fn delete_custom_agent(
    root: &Path,
    relative_path: &str,
    expected_document: &str,
) -> Result<(), CustomAgentFileError> {
    let target = resolve_file(root, relative_path)?;
    compare_current(&target, Some(expected_document))?;
    fs::remove_file(target)?;
    Ok(())
}

fn visit(
    root: &Path,
    directory: &Path,
    catalog: &mut CustomAgentCatalog,
) -> Result<(), CustomAgentFileError> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let kind = entry.file_type()?;
        let relative = path
            .strip_prefix(root)
            .map_err(|_| CustomAgentFileError::Invalid("agent path escaped its root".to_owned()))?;
        let label = relative.to_string_lossy().replace('\\', "/");

        if kind.is_symlink() {
            catalog
                .issues
                .push(format!("{label}: symbolic links are not editable"));
            continue;
        }
        if kind.is_dir() {
            visit(root, &path, catalog)?;
            continue;
        }
        /* 只有常规文件可读：一根名叫 *.md 的 FIFO 会把这次扫描挂死，is_file() 恰好排除它。 */
        #[allow(
            clippy::filetype_is_file,
            reason = "is_file() is the point: only a regular file may be read; !is_dir() would let a FIFO named *.md block the scan"
        )]
        let is_editable_markdown =
            kind.is_file() && path.extension().and_then(|value| value.to_str()) == Some("md");
        if !is_editable_markdown {
            continue;
        }

        let metadata = entry.metadata()?;
        if metadata.len() > MAX_DOCUMENT_BYTES {
            catalog
                .issues
                .push(format!("{label}: file is larger than 512 KiB"));
            continue;
        }

        match fs::read_to_string(&path) {
            Ok(document) => catalog.files.push(CustomAgentFile {
                relative_path: label,
                absolute_path: path,
                document,
            }),
            Err(_) => catalog
                .issues
                .push(format!("{label}: file could not be read as UTF-8")),
        }
    }
    Ok(())
}

fn resolve_file(root: &Path, relative_path: &str) -> Result<PathBuf, CustomAgentFileError> {
    let relative = Path::new(relative_path);
    if relative.extension().and_then(|value| value.to_str()) != Some("md")
        || relative.components().next().is_none()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(CustomAgentFileError::Invalid(
            "agent path must be a relative Markdown path".to_owned(),
        ));
    }

    let target = root.join(relative);
    let parent = target.parent().ok_or_else(|| {
        CustomAgentFileError::Invalid("agent file has no parent directory".to_owned())
    })?;
    if !parent.exists() {
        return Err(CustomAgentFileError::Invalid(
            "agent parent directory does not exist".to_owned(),
        ));
    }

    let canonical_root = root.canonicalize()?;
    let canonical_parent = parent.canonicalize()?;
    if !canonical_parent.starts_with(&canonical_root) {
        return Err(CustomAgentFileError::Invalid(
            "agent path escaped its root".to_owned(),
        ));
    }
    if target
        .symlink_metadata()
        .is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err(CustomAgentFileError::Invalid(
            "symbolic-link agent files are not editable".to_owned(),
        ));
    }
    Ok(target)
}

fn compare_current(
    target: &Path,
    expected_document: Option<&str>,
) -> Result<(), CustomAgentFileError> {
    match (fs::read_to_string(target), expected_document) {
        (Ok(current), Some(expected)) if current == expected => Ok(()),
        (Err(error), None) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        (Ok(_), _) => Err(CustomAgentFileError::Conflict),
        (Err(error), Some(_)) if error.kind() == std::io::ErrorKind::NotFound => {
            Err(CustomAgentFileError::Conflict)
        }
        (Err(error), _) => Err(CustomAgentFileError::Io(error)),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, reason = "fixture failures must stop the test")]

    use tempfile::tempdir;

    use super::{delete_custom_agent, list_custom_agents, save_custom_agent};

    #[test]
    fn save_list_and_delete_share_one_disk_truth() {
        let directory = tempdir().expect("temporary directory should exist");
        let document = "---
name: reviewer
description: Reviews code
---
Review carefully.
";
        save_custom_agent(directory.path(), "reviewer.md", document, None)
            .expect("new agent should save");

        let catalog = list_custom_agents(directory.path()).expect("catalog should load");
        assert_eq!(catalog.files.len(), 1);
        assert_eq!(
            catalog
                .files
                .first()
                .expect("saved file should be listed")
                .document,
            document
        );

        delete_custom_agent(directory.path(), "reviewer.md", document)
            .expect("unchanged agent should delete");
        assert!(
            list_custom_agents(directory.path())
                .expect("catalog should reload")
                .files
                .is_empty()
        );
    }

    #[test]
    fn stale_editor_cannot_overwrite_a_newer_document() {
        let directory = tempdir().expect("temporary directory should exist");
        save_custom_agent(directory.path(), "reviewer.md", "first", None)
            .expect("new agent should save");
        let result = save_custom_agent(directory.path(), "reviewer.md", "third", Some("second"));
        assert!(matches!(result, Err(super::CustomAgentFileError::Conflict)));
    }

    #[test]
    fn traversal_is_rejected() {
        let directory = tempdir().expect("temporary directory should exist");
        assert!(save_custom_agent(directory.path(), "../escape.md", "document", None).is_err());
    }
}
