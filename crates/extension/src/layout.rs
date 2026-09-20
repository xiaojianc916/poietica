use std::path::{Component, Path, PathBuf};

use crate::error::{ExtensionError, Result};

/// 清单的两个位置，前者优先 —— 与上游一致。
pub(crate) const MANIFEST_FILENAMES: [&str; 2] = ["kimi.plugin.json", ".kimi-plugin/plugin.json"];

const RESERVED_CHARACTERS: [char; 9] = ['<', '>', ':', '"', '|', '?', '*', '/', '\\'];

const MAX_SEGMENT_LENGTH: usize = 64;

pub fn is_safe_segment(value: &str) -> bool {
    if value.is_empty() || value.len() > MAX_SEGMENT_LENGTH || value.starts_with('.') {
        return false;
    }

    !value
        .chars()
        .any(|character| character.is_control() || RESERVED_CHARACTERS.contains(&character))
}

pub(crate) fn resolve_inside(root: &Path, relative: &str) -> Result<PathBuf> {
    let candidate = Path::new(relative);

    // 清单里的路径按上游约定一律以 ./ 开头，CurDir 段放行。
    let normal = candidate
        .components()
        .all(|component| matches!(component, Component::CurDir | Component::Normal(_)));

    if relative.is_empty() || !normal {
        return Err(ExtensionError::UnsafeSegment);
    }

    Ok(root.join(candidate))
}

pub fn manifest_in(root: &Path) -> Option<PathBuf> {
    MANIFEST_FILENAMES
        .iter()
        .map(|name| root.join(name))
        .find(|candidate| candidate.is_file())
}

/// GitHub 源码归档把全部内容套在 <repo>-<ref>/ 一层里；只脱这一层。
fn unwrap_single_directory(extracted: &Path) -> PathBuf {
    if manifest_in(extracted).is_some() {
        return extracted.to_path_buf();
    }

    let Ok(entries) = std::fs::read_dir(extracted) else {
        return extracted.to_path_buf();
    };

    let children: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();

    match children.as_slice() {
        [only] if only.is_dir() => only.clone(),
        _ => extracted.to_path_buf(),
    }
}

pub const SKILL_FILENAME: &str = "SKILL.md";

pub(crate) const DISABLED_SKILL_FILENAME: &str = "SKILL.md.disabled";

fn locate(
    extracted: &Path,
    subdirectory: Option<&str>,
    probe: impl Fn(&Path) -> bool,
) -> Result<PathBuf> {
    let unwrapped = unwrap_single_directory(extracted);

    let root = match subdirectory {
        Some(relative) => resolve_inside(&unwrapped, relative)?,
        None => unwrapped,
    };

    if probe(&root) {
        Ok(root)
    } else {
        Err(ExtensionError::ManifestMissing)
    }
}

pub fn locate_skill_root(extracted: &Path, subdirectory: Option<&str>) -> Result<PathBuf> {
    locate(extracted, subdirectory, |root| {
        root.join(SKILL_FILENAME).is_file()
    })
}

pub fn locate_root(extracted: &Path, subdirectory: Option<&str>) -> Result<PathBuf> {
    locate(extracted, subdirectory, |root| manifest_in(root).is_some())
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        reason = "a broken fixture assumption must fail the test loudly"
    )]

    use std::fs;

    use tempfile::TempDir;

    use super::{is_safe_segment, locate_root, manifest_in, resolve_inside};

    #[test]
    fn the_staging_directory_is_never_a_plugin_identifier() {
        assert!(!is_safe_segment(".staging"));
        assert!(!is_safe_segment(".."));
        assert!(!is_safe_segment("a/b"));
        assert!(!is_safe_segment("a\\b"));
        assert!(is_safe_segment("kimi-datasource"));
    }

    #[test]
    fn parent_traversal_never_resolves() {
        let root = TempDir::new().expect("temporary directory");

        assert!(resolve_inside(root.path(), "../escaped.md").is_err());
        assert!(resolve_inside(root.path(), "").is_err());
        assert!(resolve_inside(root.path(), "prompts/system.md").is_ok());
        assert!(resolve_inside(root.path(), "./skills").is_ok());
    }

    #[test]
    fn the_first_manifest_location_wins() {
        let root = TempDir::new().expect("temporary directory");

        fs::create_dir_all(root.path().join(".kimi-plugin")).expect("nested directory");
        fs::write(root.path().join(".kimi-plugin/plugin.json"), "{}").expect("nested manifest");
        fs::write(root.path().join("kimi.plugin.json"), "{}").expect("top manifest");

        assert!(
            manifest_in(root.path())
                .expect("a manifest")
                .ends_with("kimi.plugin.json")
        );
    }

    #[test]
    fn a_single_nested_directory_is_unwrapped() {
        let root = TempDir::new().expect("temporary directory");
        let nested = root.path().join("kimi-code-main");

        fs::create_dir_all(&nested).expect("nested directory");
        fs::write(nested.join("kimi.plugin.json"), "{}").expect("manifest");

        assert_eq!(locate_root(root.path(), None).expect("a root"), nested);
    }

    #[test]
    fn a_subdirectory_picks_one_plugin_out_of_a_repository() {
        let root = TempDir::new().expect("temporary directory");
        let wrapper = root.path().join("kimi-code-main");
        let wanted = wrapper.join("plugins/official/kimi-datasource");

        fs::create_dir_all(&wanted).expect("nested directory");
        fs::create_dir_all(wrapper.join("plugins/official/kimi-webbridge"))
            .expect("sibling directory");
        fs::write(wanted.join("kimi.plugin.json"), "{}").expect("manifest");

        assert_eq!(
            locate_root(root.path(), Some("plugins/official/kimi-datasource")).expect("a root"),
            wanted
        );
        assert!(locate_root(root.path(), Some("plugins/official/kimi-webbridge")).is_err());
        assert!(locate_root(root.path(), Some("../escaped")).is_err());
    }

    #[test]
    fn a_source_without_a_manifest_is_rejected() {
        let root = TempDir::new().expect("temporary directory");

        fs::write(root.path().join("README.md"), "no manifest").expect("stray file");

        assert!(locate_root(root.path(), None).is_err());
    }
}
