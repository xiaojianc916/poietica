//! 内置浏览器的宿主接线 —— 标签模型（crates/browser）与 WebView2 之间唯一的桥。
//!
//! 所有权与数据流，一句话：用户点击变成下面这些命令，命令改 BrowserHost 里的
//! 模型并驱动子 webview；内核的导航/标题回调也只写进同一个模型；每次变更
//! 广播一条 browser-state 全量快照，渲染层只投影，不另记一份。
//!
//! 渲染归 multiwebview：面板区域的页面是主窗口里的原生子 webview
//! （Window::add_child，cargo feature "unstable"），不是 iframe ——
//! X-Frame-Options/frame-ancestors 会把半个互联网挡在 iframe 外面。
//!
//! 隔离是结构性的，不靠自律：
//!   · 浏览器 profile 钉在数据根 browser/profile/（paths::browser_profile），
//!     与应用 UI webview 的用户数据完全分开；
//!   · 标签 webview 只加载外部 http(s) 地址，capabilities/main-window.json
//!     没有 remote 声明，外站 origin 在 Tauri 里调不动任何 IPC 命令；
//!   · 空白页不建 webview —— 没有导航就没有内核实例。
//!
//! 命令都不返回 Result：与 commands/window.rs 同一条规矩 —— 界面动作打不动
//! 内核不是调用方要接的错误，记进原生日志。

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl, command};
use tauri_specta::Event;

use crate::bootstrap::app::MAIN_WINDOW;

/// 子 webview 的 label 前缀。capability 按窗口配给 "main"，但这些 webview
/// 永远是外部 origin，remote 未声明即无 IPC —— 前缀只用于归属与调试。
const LABEL_PREFIX: &str = "browser-";

/// 面板视口在主窗口客户区里的逻辑坐标。渲染层量 DOM，这里只收数。
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, specta::Type)]
pub struct PanelBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// 一个标签在渲染层眼里的样子。url 缺席 = 空白页。
#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTab {
    pub id: u32,
    pub url: Option<String>,
    pub title: String,
}

/// 最近关闭的一条，够画出下拉里的那一行。
#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowserClosedTab {
    pub url: String,
    pub title: String,
}

/// 广播给渲染层的全量快照。全量而不是增量：状态就一屏标签，
/// 增量协议换来的只是两侧各一份需要对账的账本。
#[derive(Clone, Debug, Deserialize, Serialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct BrowserState {
    pub tabs: Vec<BrowserTab>,
    pub active_tab_id: Option<u32>,
    pub recently_closed: Vec<BrowserClosedTab>,
}

/// 标签状态与内核实例的唯一所有者。bootstrap 里 manage 一份，进程级。
#[derive(Debug, Default)]
pub struct BrowserHost {
    tabs: Mutex<poietica_browser_native::Tabs>,
    webviews: Mutex<HashMap<u32, tauri::Webview>>,
    bounds: Mutex<PanelBounds>,
    visible: Mutex<bool>,
}

impl BrowserHost {
    fn snapshot(&self) -> BrowserState {
        let tabs = lock(&self.tabs);

        BrowserState {
            tabs: tabs
                .entries()
                .iter()
                .map(|tab| BrowserTab {
                    id: tab.id,
                    url: tab.url.clone(),
                    title: tab.title.clone(),
                })
                .collect(),
            active_tab_id: tabs.active_id(),
            recently_closed: tabs
                .recently_closed()
                .map(|closed| BrowserClosedTab {
                    url: closed.url.clone(),
                    title: closed.title.clone(),
                })
                .collect(),
        }
    }
}

/// 锁中毒等于同伴线程已经炸了；这里的临界区只有内存读写，继续用数据是安全的。
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// 每次变更后广播快照。发不出去只说明还没有订阅者，不是故障。
fn publish(app: &AppHandle) {
    let state = app.state::<BrowserHost>().snapshot();

    if let Err(error) = state.emit(app) {
        log::warn!("browser-state event could not be delivered: {error}");
    }
}

/// 内核报来的导航（用户点了链接、重定向都走这里）。
fn note_url(app: &AppHandle, id: u32, url: &str) {
    {
        let host = app.state::<BrowserHost>();
        let mut tabs = lock(&host.tabs);
        tabs.note_url(id, url);
    }

    publish(app);
}

/// 内核报来的文档标题。
fn note_title(app: &AppHandle, id: u32, title: &str) {
    {
        let host = app.state::<BrowserHost>();
        let mut tabs = lock(&host.tabs);
        tabs.note_title(id, title);
    }

    publish(app);
}

/// 让「哪个 webview 可见」追上「哪个标签活动」。
///
/// 只有活动标签的 webview 呈现并占住面板视口；其余隐藏。面板收起时全部隐藏。
/// 这是唯一一处决定可见性的代码 —— 命令们只改状态，然后一律走这里。
fn apply_layout(app: &AppHandle) {
    let host = app.state::<BrowserHost>();
    let visible = *lock(&host.visible);
    let bounds = *lock(&host.bounds);
    let active = lock(&host.tabs).active_id();
    let webviews = lock(&host.webviews);

    for (id, webview) in webviews.iter() {
        if visible && Some(*id) == active {
            if let Err(error) = webview.set_position(LogicalPosition::new(bounds.x, bounds.y)) {
                log::warn!("browser webview position not applied: {error}");
            }

            if let Err(error) = webview.set_size(LogicalSize::new(
                bounds.width.max(1.0),
                bounds.height.max(1.0),
            )) {
                log::warn!("browser webview size not applied: {error}");
            }

            if let Err(error) = webview.show() {
                log::warn!("browser webview not shown: {error}");
            }
        } else if let Err(error) = webview.hide() {
            log::warn!("browser webview not hidden: {error}");
        }
    }
}

/// 给一个标签一台真的内核：不存在则创建，存在则导航。
///
/// 懒创建是刻意的：空白页没有 webview，也就没有任何加载与内存开销。
fn drive(app: &AppHandle, id: u32, url: &Url) {
    let existing = {
        let host = app.state::<BrowserHost>();
        let webviews = lock(&host.webviews);
        webviews.get(&id).cloned()
    };

    if let Some(mut webview) = existing {
        if let Err(error) = webview.navigate(url.clone()) {
            log::warn!("browser tab {id} refused to navigate: {error}");
        }

        return;
    }

    let Some(window) = app.get_window(MAIN_WINDOW) else {
        log::warn!("browser tab {id} has no main window to live in");
        return;
    };

    let profile = match crate::paths::browser_profile(app) {
        Ok(profile) => profile,
        Err(error) => {
            log::warn!("browser profile directory unavailable: {error}");
            return;
        }
    };

    let nav_handle = app.clone();
    let title_handle = app.clone();

    let builder = WebviewBuilder::new(
        format!("{LABEL_PREFIX}{id}"),
        WebviewUrl::External(url.clone()),
    )
    .data_directory(profile)
    .on_navigation(move |target| {
        note_url(&nav_handle, id, target.as_str());
        true
    })
    .on_document_title_changed(move |_webview, title| {
        note_title(&title_handle, id, title.as_ref());
    });

    let bounds = *lock(&app.state::<BrowserHost>().bounds);

    match window.add_child(
        builder,
        LogicalPosition::new(bounds.x, bounds.y),
        LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)),
    ) {
        Ok(webview) => {
            let host = app.state::<BrowserHost>();
            lock(&host.webviews).insert(id, webview);
        }
        Err(error) => {
            log::warn!("browser tab {id} webview was not created: {error}");
        }
    }
}

/// 渲染层进面板时拉一次的初始快照。之后靠事件。
#[command]
#[specta::specta]
pub async fn browser_state(app: AppHandle) -> BrowserState {
    app.state::<BrowserHost>().snapshot()
}

/// 开标签。不带地址就是空白页（图一的 about:blank 形态）。
#[command]
#[specta::specta]
pub async fn browser_open_tab(app: AppHandle, url: Option<String>) {
    let normalized = url
        .as_deref()
        .and_then(poietica_browser_native::normalize_address);

    let id = {
        let host = app.state::<BrowserHost>();
        let mut tabs = lock(&host.tabs);
        tabs.open(normalized.clone())
    };

    if let Some(address) = normalized
        .as_deref()
        .and_then(|value| Url::parse(value).ok())
    {
        drive(&app, id, &address);
    }

    apply_layout(&app);
    publish(&app);
}

#[command]
#[specta::specta]
pub async fn browser_close_tab(app: AppHandle, id: u32) {
    let closed = {
        let host = app.state::<BrowserHost>();
        let mut tabs = lock(&host.tabs);
        tabs.close(id).is_some()
    };

    if !closed {
        return;
    }

    let removed = {
        let host = app.state::<BrowserHost>();
        lock(&host.webviews).remove(&id)
    };

    if let Some(webview) = removed
        && let Err(error) = webview.close()
    {
        log::warn!("browser tab {id} webview did not close: {error}");
    }

    apply_layout(&app);
    publish(&app);
}

#[command]
#[specta::specta]
pub async fn browser_select_tab(app: AppHandle, id: u32) {
    let changed = {
        let host = app.state::<BrowserHost>();
        let mut tabs = lock(&host.tabs);
        tabs.select(id)
    };

    if changed {
        apply_layout(&app);
        publish(&app);
    }
}

/// 地址栏回车。规整不出 URL 就什么也不做 —— 这个地址栏只认 URL，不做搜索。
#[command]
#[specta::specta]
pub async fn browser_navigate(app: AppHandle, id: u32, address: String) {
    let Some(normalized) = poietica_browser_native::normalize_address(&address) else {
        log::warn!("browser address was not a navigable url");
        return;
    };

    let Ok(url) = Url::parse(&normalized) else {
        log::warn!("browser address survived normalization but not parsing");
        return;
    };

    let known = {
        let host = app.state::<BrowserHost>();
        let mut tabs = lock(&host.tabs);
        tabs.navigate(id, &normalized)
    };

    if !known {
        return;
    }

    drive(&app, id, &url);
    apply_layout(&app);
    publish(&app);
}

/// 后退。历史归内核所有，这里只请求 —— 没有历史时它自然无事发生，
/// 与浏览器本体的行为一致，不另记一份「能不能后退」的影子账。
#[command]
#[specta::specta]
pub async fn browser_back(app: AppHandle, id: u32) {
    run_in_page(&app, id, "history.back()");
}

#[command]
#[specta::specta]
pub async fn browser_forward(app: AppHandle, id: u32) {
    run_in_page(&app, id, "history.forward()");
}

#[command]
#[specta::specta]
pub async fn browser_reload(app: AppHandle, id: u32) {
    run_in_page(&app, id, "location.reload()");
}

fn run_in_page(app: &AppHandle, id: u32, script: &'static str) {
    let webview = {
        let host = app.state::<BrowserHost>();
        lock(&host.webviews).get(&id).cloned()
    };

    let Some(webview) = webview else {
        return;
    };

    if let Err(error) = webview.eval(script) {
        log::warn!("browser tab {id} rejected {script}: {error}");
    }
}

/// 重开最近关闭下拉里的第 index 条。
#[command]
#[specta::specta]
pub async fn browser_reopen_closed(app: AppHandle, index: u32) {
    let reopened = {
        let host = app.state::<BrowserHost>();
        let mut tabs = lock(&host.tabs);
        tabs.reopen(index as usize)
    };

    let Some((id, url)) = reopened else {
        return;
    };

    if let Ok(parsed) = Url::parse(&url) {
        drive(&app, id, &parsed);
    }

    apply_layout(&app);
    publish(&app);
}

/// 渲染层量好的视口逻辑坐标。React 只报数，摆放由这里做。
#[command]
#[specta::specta]
pub async fn browser_set_bounds(app: AppHandle, x: f64, y: f64, width: f64, height: f64) {
    {
        let host = app.state::<BrowserHost>();
        *lock(&host.bounds) = PanelBounds {
            x,
            y,
            width,
            height,
        };
    }

    apply_layout(&app);
}

/// 面板开合（含切到非对话表面）。隐藏不销毁：标签还在，回来接着用。
#[command]
#[specta::specta]
pub async fn browser_set_visible(app: AppHandle, visible: bool) {
    {
        let host = app.state::<BrowserHost>();
        *lock(&host.visible) = visible;
    }

    apply_layout(&app);
}

/// 图三「打开调试工具」：WebView2 的 DevTools 独立窗口。
#[command]
#[specta::specta]
pub async fn browser_open_devtools(app: AppHandle, id: u32) {
    let webview = {
        let host = app.state::<BrowserHost>();
        lock(&host.webviews).get(&id).cloned()
    };

    if let Some(webview) = webview {
        webview.open_devtools();
    }
}
