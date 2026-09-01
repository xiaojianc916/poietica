//! Shared, canonical-root filesystem watchers with explicit leases.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use crate::GitError;

type Announce = Arc<dyn Fn(PathBuf) + Send + Sync + 'static>;
struct Entry { watcher: RecommendedWatcher, leases: usize }
#[derive(Default)] struct RegistryState { entries: HashMap<PathBuf, Entry>, tokens: HashMap<String, PathBuf> }
#[derive(Default)] pub struct WatchRegistry { state: Mutex<RegistryState> }

impl WatchRegistry {
    pub fn acquire(&self, root: &Path, token: String, announce: Announce) -> Result<PathBuf, GitError> {
        let canonical = root.canonicalize().map_err(GitError::WatchRoot)?;
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(held) = state.tokens.get(&token) {
            return if held == &canonical { Ok(canonical) } else { Err(GitError::Refused("watch lease token is already in use".to_owned())) };
        }
        if !state.entries.contains_key(&canonical) {
            let watched = canonical.clone();
            let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                let Ok(event) = event else { return; };
                if matches!(event.kind, EventKind::Access(_)) || !event.paths.iter().any(|path| noteworthy(path)) { return; }
                announce(watched.clone());
            })?;
            watcher.watch(&canonical, RecursiveMode::Recursive)?;
            state.entries.insert(canonical.clone(), Entry { watcher, leases: 0 });
        }
        state.tokens.insert(token, canonical.clone());
        state.entries.get_mut(&canonical).expect("entry was inserted").leases += 1;
        Ok(canonical)
    }
    pub fn release(&self, token: &str) -> bool {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(root) = state.tokens.remove(token) else { return false; };
        let remove = if let Some(entry) = state.entries.get_mut(&root) { entry.leases = entry.leases.saturating_sub(1); entry.leases == 0 } else { false };
        if remove { state.entries.remove(&root); }
        true
    }
    pub fn clear(&self) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.tokens.clear(); state.entries.clear();
    }
}

fn noteworthy(path: &Path) -> bool {
    let inside_git = path.components().any(|part| part.as_os_str() == ".git");
    !inside_git || path.file_name().is_some_and(|name| name == "HEAD" || name == "index" || name == "packed-refs")
}

#[cfg(test)]
mod tests {
    use super::noteworthy;
    use std::path::Path;
    #[test] fn git_internals_do_not_count_except_head() {
        assert!(noteworthy(Path::new("src/lib.rs")));
        assert!(noteworthy(Path::new(".git/HEAD")));
        assert!(noteworthy(Path::new(".git/index")));
    }
}
