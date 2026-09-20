//! 标签页模型的唯一事实来源；宿主接线（渲染与导航）归 apps/desktop/src-tauri/src/webview/bridge.rs，本 crate 须能无窗口跑完全部单测。

mod picker;

pub use picker::{
    PickOutcome, PickSubmission, PickedElement, Picker, PickerLease, decode_picker_callback,
    is_picker_callback,
};

use std::collections::{HashMap, VecDeque};

use base64::Engine as _;

pub(crate) const RECENTLY_CLOSED_CAP: usize = 10;

/// 空白页写法的唯一产地。模型里空白页是 url 缺席（None：未导航过，也没有对应 webview）。
pub const BLANK_PAGE: &str = "about:blank";

pub(crate) type TabId = u32;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tab {
    pub id: TabId,
    pub url: Option<String>,
    pub title: String,
    pub loading: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClosedTab {
    pub url: String,
    pub title: String,
}

/// 所有标签变更的唯一入口：宿主与 UI 都不得各自记一份。
#[derive(Debug, Default)]
pub struct Tabs {
    entries: Vec<Tab>,
    active: Option<TabId>,
    recently_closed: VecDeque<ClosedTab>,
    next_id: TabId,
    icons: HashMap<String, String>,
}

impl Tabs {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn open(&mut self, url: Option<String>) -> TabId {
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1);

        let title = url
            .as_deref()
            .map_or_else(|| "新标签页".to_owned(), display_host);

        let loading = url.is_some();

        self.entries.push(Tab {
            id,
            url,
            title,
            loading,
        });
        self.active = Some(id);

        id
    }

    pub fn close(&mut self, id: TabId) -> bool {
        let Some(index) = self.entries.iter().position(|tab| tab.id == id) else {
            return false;
        };
        let removed = self.entries.remove(index);

        if let Some(url) = removed.url {
            if self.recently_closed.len() == RECENTLY_CLOSED_CAP {
                self.recently_closed.pop_back();
            }
            self.recently_closed.push_front(ClosedTab {
                url,
                title: removed.title,
            });
        }

        if self.active == Some(id) {
            self.active = self
                .entries
                .get(index)
                .or_else(|| self.entries.get(index.wrapping_sub(1)))
                .map(|tab| tab.id);
        }

        let entries = &self.entries;

        self.icons.retain(|origin, _| {
            entries
                .iter()
                .filter_map(|tab| tab.url.as_deref())
                .filter_map(origin_of)
                .any(|live| live == *origin)
        });

        true
    }

    pub fn select(&mut self, id: TabId) -> bool {
        if self.entries.iter().any(|tab| tab.id == id) {
            self.active = Some(id);
            return true;
        }

        false
    }

    pub fn navigate(&mut self, id: TabId, url: &str) -> bool {
        let Some(tab) = self.entries.iter_mut().find(|tab| tab.id == id) else {
            return false;
        };

        tab.title = display_host(url);
        tab.url = Some(url.to_owned());
        tab.loading = true;

        true
    }

    pub fn note_url(&mut self, id: TabId, url: &str) {
        if let Some(tab) = self.entries.iter_mut().find(|tab| tab.id == id) {
            tab.url = if url == BLANK_PAGE {
                None
            } else {
                Some(url.to_owned())
            };
        }
    }

    pub fn note_title(&mut self, id: TabId, title: &str) {
        if title.is_empty() {
            return;
        }

        if let Some(tab) = self.entries.iter_mut().find(|tab| tab.id == id) {
            title.clone_into(&mut tab.title);
        }
    }

    pub fn note_loading(&mut self, id: TabId, loading: bool) {
        if let Some(tab) = self.entries.iter_mut().find(|tab| tab.id == id) {
            tab.loading = loading;
        }
    }

    pub fn reopen(&mut self, index: usize) -> Option<(TabId, String)> {
        let record = self.recently_closed.remove(index)?;
        let id = self.open(Some(record.url.clone()));

        Some((id, record.url))
    }

    #[must_use]
    pub fn showing(&self) -> Option<TabId> {
        self.entries
            .iter()
            .find(|tab| Some(tab.id) == self.active && tab.url.is_some())
            .map(|tab| tab.id)
    }

    #[must_use]
    pub fn has_icon(&self, origin: &str) -> bool {
        self.icons.contains_key(origin)
    }

    pub fn note_icon(&mut self, origin: String, icon: String) {
        self.icons.insert(origin, icon);
    }

    #[must_use]
    pub fn icon(&self, id: TabId) -> Option<&str> {
        let tab = self.entries.iter().find(|tab| tab.id == id)?;
        let origin = origin_of(tab.url.as_deref()?)?;

        self.icons.get(&origin).map(String::as_str)
    }

    #[must_use]
    pub fn active_id(&self) -> Option<TabId> {
        self.active
    }

    #[must_use]
    pub fn entries(&self) -> &[Tab] {
        &self.entries
    }

    pub fn recently_closed(&self) -> impl Iterator<Item = &ClosedTab> {
        self.recently_closed.iter()
    }
}

#[must_use]
pub fn normalize_address(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Ok(parsed) = url::Url::parse(trimmed) {
        if matches!(parsed.scheme(), "http" | "https") {
            parsed.host()?;
            return Some(parsed.into());
        }
        if parsed.scheme() == "file" {
            if parsed.host_str().is_some() {
                return None;
            }
            let path = parsed.to_file_path().ok()?;
            return path.is_absolute().then(|| parsed.into());
        }
        if trimmed.contains("://") || trimmed.starts_with("file:") {
            return None;
        }
    }

    if trimmed.contains(' ') {
        return None;
    }
    let scheme = if is_local_authority(trimmed) {
        "http"
    } else {
        "https"
    };
    let mut candidate = scheme.to_owned();
    candidate.push_str("://");
    candidate.push_str(trimmed);
    let parsed = url::Url::parse(&candidate).ok()?;
    if scheme == "https" && !parsed.host_str()?.contains('.') {
        return None;
    }
    Some(parsed.into())
}
fn is_local_authority(input: &str) -> bool {
    let authority = input.split('/').next().unwrap_or(input);
    let host = authority
        .rsplit_once(':')
        .map_or(authority, |(head, _)| head);

    host == "localhost" || host.parse::<std::net::IpAddr>().is_ok()
}

fn display_host(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_owned))
        .unwrap_or_else(|| url.to_owned())
}

fn origin_of(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;

    matches!(parsed.scheme(), "http" | "https").then(|| parsed.origin().ascii_serialization())
}

#[must_use]
pub fn icon_probe(page: &str) -> Option<(String, String)> {
    let origin = origin_of(page)?;
    let probe = url::Url::parse(&origin).ok()?.join("/favicon.ico").ok()?;

    Some((origin, probe.into()))
}

/// 只收 image/*：服务器对缺失的图标常回 200 加一页 HTML，那不是图标。
#[must_use]
pub fn icon_data_url(content_type: &str, bytes: &[u8]) -> Option<String> {
    const MAX_ICON_BYTES: usize = 128 * 1024;

    let mime = content_type.split(';').next()?.trim();

    if !mime.starts_with("image/") || bytes.is_empty() || bytes.len() > MAX_ICON_BYTES {
        return None;
    }

    Some(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// 走 HTTP 而非 WebView2 的 FaviconChanged（后者只能经 COM 拿，而根 Cargo.toml 是 unsafe_code = "deny"）；失败只是没有图标。
pub async fn fetch_icon_data_url(probe: &str) -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .ok()?;

    let response = client.get(probe).send().await.ok()?;

    if !response.status().is_success() {
        return None;
    }

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();

    let bytes = response.bytes().await.ok()?;

    icon_data_url(&content_type, &bytes)
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
        assert_eq!(tabs.entries().first().map(|tab| tab.id), Some(first),);
        assert_eq!(tabs.active_id(), Some(second));
        assert_eq!(
            tabs.entries().get(1).map(|tab| tab.title.as_str()),
            Some("example.com"),
        );
    }

    #[test]
    fn closing_active_moves_focus_to_right_then_left() {
        let mut tabs = Tabs::new();
        let a = tabs.open(Some("https://a.example/".to_owned()));
        let b = tabs.open(Some("https://b.example/".to_owned()));
        let c = tabs.open(Some("https://c.example/".to_owned()));

        tabs.select(b);
        assert!(tabs.close(b));
        assert_eq!(tabs.active_id(), Some(c));

        assert!(tabs.close(c));
        assert_eq!(tabs.active_id(), Some(a));

        assert!(tabs.close(a));
        assert_eq!(tabs.active_id(), None);
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

        assert!(tabs.close(blank));
        assert_eq!(tabs.recently_closed().count(), 0);
    }

    fn ring_url(index: usize) -> String {
        format!("https://site-{index}.example/")
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
        assert_eq!(
            tabs.entries().first().map(|tab| tab.title.as_str()),
            Some("Example Domain"),
        );
    }

    #[test]
    fn loading_follows_navigation_and_kernel_reports() {
        let mut tabs = Tabs::new();
        let blank = tabs.open(None);
        assert!(!tabs.entries().first().unwrap().loading);

        tabs.navigate(blank, "https://example.com/");
        assert!(tabs.entries().first().unwrap().loading);

        tabs.note_loading(blank, false);
        assert!(!tabs.entries().first().unwrap().loading);
    }

    #[test]
    fn the_kernel_blank_page_stays_the_models_blank_tab() {
        let mut tabs = Tabs::new();
        let id = tabs.open(None);

        tabs.note_url(id, BLANK_PAGE);
        assert!(tabs.entries().first().unwrap().url.is_none());
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
        assert_eq!(normalize_address(""), None);
        assert!(normalize_address("file:///C:/tmp/example.html").is_some());
        assert_eq!(normalize_address("file://server/share/example.html"), None);
        assert_eq!(normalize_address("relative/example.html"), None);
    }

    #[test]
    fn accepts_local_development_addresses() {
        assert_eq!(
            normalize_address("localhost:5173").as_deref(),
            Some("http://localhost:5173/")
        );
        assert_eq!(
            normalize_address("127.0.0.1:3000/app").as_deref(),
            Some("http://127.0.0.1:3000/app")
        );
        assert_eq!(
            normalize_address("localhost").as_deref(),
            Some("http://localhost/")
        );
    }

    #[test]
    fn a_blank_active_tab_has_nothing_to_show() {
        let mut tabs = Tabs::new();
        let blank = tabs.open(None);

        assert_eq!(tabs.active_id(), Some(blank));
        assert_eq!(tabs.showing(), None);

        tabs.navigate(blank, "https://example.com/");
        assert_eq!(tabs.showing(), Some(blank));
    }

    #[test]
    fn icons_are_shared_by_origin_and_leave_with_the_last_tab() {
        let mut tabs = Tabs::new();
        let first = tabs.open(Some("https://example.com/a".to_owned()));
        let second = tabs.open(Some("https://example.com/b".to_owned()));

        let (origin, probe) = icon_probe("https://example.com/a").unwrap();
        assert_eq!(probe, "https://example.com/favicon.ico");

        tabs.note_icon(origin.clone(), "data:image/gif;base64,R0lGODlh".to_owned());

        assert_eq!(tabs.icon(first), tabs.icon(second));

        tabs.close(first);
        assert!(tabs.has_icon(&origin));

        tabs.close(second);
        assert!(!tabs.has_icon(&origin));
    }

    #[test]
    fn only_image_bytes_become_an_icon() {
        assert!(icon_data_url("text/html; charset=utf-8", b"<!doctype html>").is_none());
        assert!(icon_data_url("image/png", b"").is_none());
        assert_eq!(
            icon_data_url("image/gif;charset=binary", b"GIF89a").as_deref(),
            Some("data:image/gif;base64,R0lGODlh")
        );
    }
}
