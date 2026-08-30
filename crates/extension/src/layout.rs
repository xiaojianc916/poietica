use std::path::{Component, Path, PathBuf};

use crate::error::{ExtensionError, Result};

/// 清单的两个位置，前者优先 —— 与上游一致。
///
/// 第二条带斜杠：Rust 的 Path 在 Windows 上同样把 '/' 当分隔符，不需要写第二份。
pub(crate) const MANIFEST_FILENAMES: [&str; 2] = ["kimi.plugin.json", ".kimi-plugin/plugin.json"];

/// Windows 的保留字符加两个分隔符。Path::join 不拒绝它们，要到创建文件那一刻
/// 才失败，而那时暂存区已经写了一半。
const RESERVED_CHARACTERS: [char; 9] = ['<', '>', ':', '"', '|', '?', '*', '/', '\\'];

const MAX_SEGMENT_LENGTH: usize = 64;

/// 这个字符串能不能当一个目录名用。
///
/// 判的是文件系统的事，不是清单的事：清单里 name 合不合法由 packages/plugins 的
/// 解码器说了算。点开头一律拒绝 —— 这一条同时挡掉 "."、".." 与暂存目录
/// ".staging"，所以列举托管副本时不需要再写一个特例把它跳过去。
pub fn is_safe_segment(value: &str) -> bool {
    if value.is_empty() || value.len() > MAX_SEGMENT_LENGTH || value.starts_with('.') {
        return false;
    }

    !value
        .chars()
        .any(|character| character.is_control() || RESERVED_CHARACTERS.contains(&character))
}

/// 把一条相对路径接在根上，并保证结果仍在根里面。
///
/// 判据是「每一段都必须是普通名字」：".." 往上跳，而绝对路径与 Windows 盘符前缀
/// 会让 Path::join 丢掉左边整段 —— join("C:\\x") 返回的是 C:\x。这是 std 写明的行为。
pub(crate) fn resolve_inside(root: &Path, relative: &str) -> Result<PathBuf> {
    let candidate = Path::new(relative);

    // CurDir 一并放行。清单里的路径按上游约定一律以 ./ 开头，而 Path::components 只在
    // 路径开头保留 '.'（其余位置归一掉），于是 "./skills" 会带一个 CurDir 段进来。它
    // 跳不出根，拒了它等于拒掉上游的写法本身。
    let normal = candidate
        .components()
        .all(|component| matches!(component, Component::CurDir | Component::Normal(_)));

    if relative.is_empty() || !normal {
        return Err(ExtensionError::UnsafeSegment);
    }

    Ok(root.join(candidate))
}

/// 这个目录里的清单在哪。两个位置按上游的优先级依次试。
pub fn manifest_in(root: &Path) -> Option<PathBuf> {
    MANIFEST_FILENAMES
        .iter()
        .map(|name| root.join(name))
        .find(|candidate| candidate.is_file())
}

/// 归档解开之后套着的那一层壳。
///
/// GitHub 的源码归档把全部内容套在 <repo>-<ref>/ 一层里，本地目录通常没有这一层。
/// 顶层有清单就是顶层；没有而恰好只有一个子目录，那一层就是壳。只脱一层。
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

/// 技能目录的判据文件。技能没有清单，SKILL.md 本身就是身份。
pub const SKILL_FILENAME: &str = "SKILL.md";

/// 停用的写法：改名，不删文件。CLI 只装载 SKILL.md，改回来即恢复。
pub(crate) const DISABLED_SKILL_FILENAME: &str = "SKILL.md.disabled";

/// 解出来的那一堆东西里，根在哪。probe 说什么算根。
///
/// subdirectory 相对脱壳之后那一层：<repo>-<ref>/ 那层壳的名字里带着 ref，调用方
/// 写不出来也不该知道。一个仓库装多个插件是目录型市场的常态，不指名就只能猜。
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

/// 技能的根。技能没有清单，SKILL.md 本身就是身份。
pub fn locate_skill_root(extracted: &Path, subdirectory: Option<&str>) -> Result<PathBuf> {
    locate(extracted, subdirectory, |root| {
        root.join(SKILL_FILENAME).is_file()
    })
}

/// 插件的根。判据是清单在不在。
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
        // 清单里的路径都长这样，拒了它就等于拒了上游写法。
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
