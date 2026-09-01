//! Shared, canonical-root filesystem watchers with explicit leases.
use crate::GitError;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

type Announce = Arc<dyn Fn(PathBuf) + Send + Sync + 'static>;
struct Entry {
    // 只被持有，从不读取：Drop 掉它就停止 notify 订阅，运行期靠这个副作用维持。
    #[expect(
        dead_code,
        reason = "dropped to stop the notify subscription; never read"
    )]
    watcher: RecommendedWatcher,
    leases: usize,
}
#[derive(Default)]
struct RegistryState {
    entries: HashMap<PathBuf, Entry>,
    tokens: HashMap<String, PathBuf>,
}
#[derive(Default)]
pub struct WatchRegistry {
    state: Mutex<RegistryState>,
}

impl std::fmt::Debug for WatchRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 载荷含 watcher 句柄，不印它（§5 Debug 不打载荷）。
        f.debug_struct("WatchRegistry").finish_non_exhaustive()
    }
}

impl WatchRegistry {
    pub fn acquire(
        &self,
        root: &Path,
        token: String,
        announce: Announce,
    ) -> Result<PathBuf, GitError> {
        let canonical = root.canonicalize().map_err(GitError::WatchRoot)?;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(held) = state.tokens.get(&token) {
            return if held == &canonical {
                Ok(canonical)
            } else {
                Err(GitError::Refused(
                    "watch lease token is already in use".to_owned(),
                ))
            };
        }
        if let Some(entry) = state.entries.get_mut(&canonical) {
            entry.leases += 1;
            state.tokens.insert(token, canonical.clone());
            return Ok(canonical);
        }
        let watched_root = canonical.clone();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                let Ok(event) = event else {
                    return;
                };
                if matches!(event.kind, EventKind::Access(_))
                    || !event.paths.iter().any(|path| noteworthy(path))
                {
                    return;
                }
                announce(watched_root.clone());
            })?;
        watcher.watch(&canonical, RecursiveMode::Recursive)?;
        state
            .entries
            .insert(canonical.clone(), Entry { watcher, leases: 1 });
        state.tokens.insert(token, canonical.clone());
        Ok(canonical)
    }
    pub fn release(&self, token: &str) -> bool {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(root) = state.tokens.remove(token) else {
            return false;
        };
        let remove = if let Some(entry) = state.entries.get_mut(&root) {
            entry.leases = entry.leases.saturating_sub(1);
            entry.leases == 0
        } else {
            false
        };
        if remove {
            state.entries.remove(&root);
        }
        true
    }
    pub fn clear(&self) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.tokens.clear();
        state.entries.clear();
    }
}

fn noteworthy(path: &Path) -> bool {
    let inside_git = path.components().any(|part| part.as_os_str() == ".git");
    !inside_git
        || path
            .file_name()
            .is_some_and(|name| name == "HEAD" || name == "index" || name == "packed-refs")
}

#[cfg(test)]
mod tests {
    use super::noteworthy;
    use std::path::Path;
    #[test]
    fn git_internals_do_not_count_except_head() {
        assert!(noteworthy(Path::new("src/lib.rs")));
        assert!(noteworthy(Path::new(".git/HEAD")));
        assert!(noteworthy(Path::new(".git/index")));
    }
}
