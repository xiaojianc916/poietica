# @poietica/auxiliary

Owns the right-hand auxiliary product area: pane identity, focus/menu lifecycle, and browser, review, and terminal contracts and views.

The desktop shell owns only region layout and composition. Conversation owns delegate sessions and injects their renderer. Rust crates continue to own WebView, git, PTY, process, and event lifetimes.

Public access is limited to the declared package subpath exports; no root barrel or compatibility alias is provided.
