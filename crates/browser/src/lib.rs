//! 内置浏览器的标签页模型 —— 唯一的事实来源。
//!
//! 这里只有状态与不变式：标签的次序、活动标签、关闭后的焦点迁移、最近关闭
//! 的环、地址的规整。谁来渲染、谁来导航（WebView2、CDP、还是测试桩）不在
//! 这一层出现 —— 宿主接线归 src-tauri 的 browser.rs，本 crate 必须能在
//! 没有窗口的进程里跑完全部单测。

use std::collections::VecDeque;

/// 最近关闭的环的容量。第 11 条进来时最老的一条出去。
pub const RECENTLY_CLOSED_CAP: usize = 10;

/// 标签标识。u32 足够（一个进程开不满四十亿个标签），并且能无损过 IPC。
pub type TabId = u32;

/// 一个标签页。url 为 None 表示空白页：还没有导航过，也没有对应的 webview。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tab {
    pub id: TabId,
    pub url: Option<String>,
    pub title: String,
}

/// 最近关闭的一条。空白页关掉不进环 —— 重开一个空白页没有意义。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClosedTab {
    pub url: String,
    pub title: String,
}

/// 关闭一个标签的结果：进了环的记录（若有），以及焦点迁去了哪。
#[derive(Debug, PartialEq, Eq)]
pub struct CloseOutcome {
    pub remembered: bool,
    pub next_active: Option<TabId>,
}

/// 标签集合。所有变更都从这里过 —— 宿主与 UI 都不得各自记一份。
#[derive(Debug, Default)]
pub struct Tabs {
    entries: Vec<Tab>,
    active: Option<TabId>,
    recently_closed: VecDeque<ClosedTab>,
    next_id: TabId,
}

impl Tabs {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// 开一个标签并激活它。url 为 None 时是空白页。
    pub fn open(&mut self, url: Option<String>) -> TabId {
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1);

        let title = url.as_deref().map_or_else(|| "新标签页".to_owned(), display_host);

        self.entries.push(Tab { id, url, title });
        self.active = Some(id);

        id
    }

    /// 关一个标签。焦点迁移规则与主流浏览器一致：先右邻，无右邻取左邻。
    pub fn close(&mut self, id: TabId) -> Option<CloseOutcome> {
        let index = self.entries.iter().position(|tab| tab.id == id)?;
        let removed = self.entries.remove(index);

        let remembered = match removed.url {
            Some(url) => {
                if self.recently_closed.len() == RECENTLY_CLOSED_CAP {
                    self.recently_closed.pop_back();
                }
                self.recently_closed.push_front(ClosedTab { url, title: removed.title });
                true
            }
            None => false,
        };

        if self.active == Some(id) {
            self.active = self
                .entries
                .get(index)
                .or_else(|| self.entries.get(index.wrapping_sub(1)))
                .map(|tab| tab.id);
        }

        Some(CloseOutcome { remembered, next_active: self.active })
    }

    /// 激活一个标签。不存在的 id 返回 false，状态不变。
    pub fn select(&mut self, id: TabId) -> bool {
        if self.entries.iter().any(|tab| tab.id == id) {
            self.active = Some(id);
            return true;
        }

        false
    }

    /// 记录一次导航意图：地址落到标签上，标题先用主机名顶着，真标题随事件到。
    pub fn navigate(&mut self, id: TabId, url: &str) -> bool {
        let Some(tab) = self.entries.iter_mut().find(|tab| tab.id == id) else {
            return false;
        };

        tab.title = display_host(url);
        tab.url = Some(url.to_owned());

        true
    }

    /// 内核报来的真实地址（重定向、页内跳转都从这里回来）。
    pub fn note_url(&mut self, id: TabId, url: &str) {
        if let Some(tab) = self.entries.iter_mut().find(|tab| tab.id == id) {
            tab.url = Some(url.to_owned());
        }
    }

    /// 内核报来的文档标题。空串不覆盖 —— 那只是文档还没解析完。
    pub fn note_title(&mut self, id: TabId, title: &str) {
        if title.is_empty() {
            return;
        }

        if let Some(tab) = self.entries.iter_mut().find(|tab| tab.id == id) {
            tab.title = title.to_owned();
        }
    }

    /// 重开最近关闭环里的第 index 条：从环里取出，开成新标签。
    pub fn reopen(&mut self, index: usize) -> Option<(TabId, String)> {
        let record = self.recently_closed.remove(index)?;
        let id = self.open(Some(record.url.clone()));

        Some((id, record.url))
    }

    #[must_use]
    pub fn active(&self) -> Option<&Tab> {
        let id = self.active?;

        self.entries.iter().find(|tab| tab.id == id)
    }

    #[must_use]
    pub fn active_id(&self) -> Option<TabId> {
        self.active
    }

    #[must_use]
    pub fn entries(&self) -> &[Tab] {
        &self.entries
    }

    #[must_use]
    pub fn recently_closed(&self) -> impl Iterator<Item = &ClosedTab> {
        self.recently_closed.iter()
    }
}

/// 把地址栏输入规整成可导航的 URL。
///
/// 规则与地址栏占位「粘贴或输入 URL」一致：只认 URL，不做搜索。
/// 有 http/https 方案的原样收下；裸主机名补 https://；规整不出来返回 None。
#[must_use]
pub fn normalize_address(input: &str) -> Option<String> {
    let trimmed = input.trim();

    if trimmed.is_empty() {
        return None;
    }

    let candidate = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_owned()
    } else if trimmed.contains(' ') || !trimmed.contains('.') {
        return None;
    } else {
    let mut prefixed = String::from("https://");
    prefixed.push_str(trimmed);
    prefixed
};

    let parsed = url::Url::parse(&candidate).ok()?;

    if parsed.host().is_none() {
        return None;
    }

    Some(parsed.into())
}

/// 一条 URL 在标签上的临时名字：主机名。解析不出来就原样显示。
fn display_host(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_owned))
        .unwrap_or_else(|| url.to_owned())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "测试内的失败就该当场炸")]

    use super::*;

    #[test]
    fn opens_append_in_order_and_activate() {
        let mut tabs = Tabs::new();
        let first = tabs.open(None);
        let second = tabs.open(Some("https://example.com/".to_owned()));

        assert_eq!(tabs.entries().len(), 2);
        assert_eq!(tabs.entries()[0].id, first);
        assert_eq!(tabs.active_id(), Some(second));
        assert_eq!(tabs.entries()[1].title, "example.com");
    }

    #[test]
    fn closing_active_moves_focus_to_right_then_left() {
        let mut tabs = Tabs::new();
        let a = tabs.open(Some("https://a.example/".to_owned()));
        let b = tabs.open(Some("https://b.example/".to_owned()));
        let c = tabs.open(Some("https://c.example/".to_owned()));

        tabs.select(b);
        let outcome = tabs.close(b).unwrap();
        assert_eq!(outcome.next_active, Some(c));

        let outcome = tabs.close(c).unwrap();
        assert_eq!(outcome.next_active, Some(a));

        let outcome = tabs.close(a).unwrap();
        assert_eq!(outcome.next_active, None);
    }

    #[test]
    fn closing_inactive_keeps_focus() {
        let mut tabs = Tabs::new();
        let a = tabs.open(Some("https://a.example/".to_owned()));
        let b = tabs.open(Some("https://b.example/".to_owned()));

        tabs.select(b);
        tabs.close(a);
        assert_eq!(tabs.active_id(), Some(b));
    }

    #[test]
    fn blank_tabs_are_not_remembered() {
        let mut tabs = Tabs::new();
        let blank = tabs.open(None);

        let outcome = tabs.close(blank).unwrap();
        assert!(!outcome.remembered);
        assert_eq!(tabs.recently_closed().count(), 0);
    }

    #[test]
    fn ring_url(index: usize) -> String {
    let mut url = String::from("https://");
    url.push_str(&format!("site-{index}.example/"));
    url
}

#[test]
fn recently_closed_is_lifo_and_capped() {
    let mut tabs = Tabs::new();

    for index in 0..=RECENTLY_CLOSED_CAP {
        let id = tabs.open(Some(ring_url(index)));
        tabs.close(id);
    }

    assert_eq!(tabs.recently_closed().count(), RECENTLY_CLOSED_CAP);

    let newest = tabs.recently_closed().next().unwrap();
    assert_eq!(newest.url, ring_url(RECENTLY_CLOSED_CAP));

    let oldest = tabs.recently_closed().last().unwrap();
    assert_eq!(oldest.url, ring_url(1));
}

    #[test]
    fn reopen_takes_the_requested_entry_out_of_the_ring() {
        let mut tabs = Tabs::new();
        let a = tabs.open(Some("https://a.example/".to_owned()));
        let b = tabs.open(Some("https://b.example/".to_owned()));
        tabs.close(a);
        tabs.close(b);

        let (reopened, url) = tabs.reopen(1).unwrap();
        assert_eq!(url, "https://a.example/");
        assert_eq!(tabs.active_id(), Some(reopened));
        assert_eq!(tabs.recently_closed().count(), 1);
        assert!(tabs.reopen(5).is_none());
    }

    #[test]
    fn select_unknown_id_is_refused() {
        let mut tabs = Tabs::new();
        tabs.open(None);

        assert!(!tabs.select(999));
    }

    #[test]
    fn empty_title_does_not_overwrite() {
        let mut tabs = Tabs::new();
        let id = tabs.open(Some("https://example.com/".to_owned()));

        tabs.note_title(id, "Example Domain");
        tabs.note_title(id, "");
        assert_eq!(tabs.entries()[0].title, "Example Domain");
    }

    #[test]
    fn normalize_accepts_urls_and_rejects_prose() {
        assert_eq!(
            normalize_address("  example.com  ").as_deref(),
            Some("https://example.com/")
        );
        assert_eq!(
            normalize_address("http://example.com/a?b=c").as_deref(),
            Some("http://example.com/a?b=c")
        );
        assert_eq!(normalize_address("what is rust"), None);
        assert_eq!(normalize_address("localhost"), None);
        assert_eq!(normalize_address(""), None);
    }
}
