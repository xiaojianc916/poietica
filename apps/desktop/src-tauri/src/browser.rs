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

/// 拾取回传的哨兵地址。`.invalid` 是 RFC 2606 保留 TLD，永不解析；载荷全在
/// query 里 —— 即使被取消的导航仍有请求发出（WebView2 已知行为），它也到不了
/// 任何真实服务器。
const PICK_SENTINEL: &str = "https://pick.poietica.invalid/";

/// 注入页面的拾取脚本：hover 高亮、点击定案、Esc 取消。
/// 回传走哨兵导航 —— 标签 webview 是外部 origin，结构性无 IPC，这是唯一
/// 不开新信道、不放宽隔离的回传口。幂等：重复注入是空操作。
/// 已知边界：iframe 里的元素只拾取到 iframe 本身。
const PICKER_SCRIPT: &str = r"(() => {
  if (window.__poieticaPicker) { return; }
  window.__poieticaPicker = true;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;'
    + 'z-index:2147483647;pointer-events:none;display:none;'
    + 'background:rgba(59,130,246,0.22);outline:2px solid rgba(59,130,246,0.9);';
  let over = null;
  const selectorFor = (start) => {
    const parts = [];
    let node = start;
    while (node && node.nodeType === 1 && parts.length < 6) {
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const twins = Array.prototype.filter.call(parent.children, (child) => child.tagName === node.tagName);
        if (twins.length > 1) { part += ':nth-of-type(' + (twins.indexOf(node) + 1) + ')'; }
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  };
  const cleanup = () => {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    delete window.__poieticaPicker;
  };
  const finish = (params) => {
    cleanup();
    location.href = 'https://pick.poietica.invalid/?' + params.toString();
  };
  const onMove = (event) => {
    const el = document.elementFromPoint(event.clientX, event.clientY);
    if (!el || el === over) { return; }
    over = el;
    const rect = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = rect.left + 'px';
    overlay.style.top = rect.top + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
  };
  const onClick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const el = over || event.target;
    const params = new URLSearchParams();
    params.set('url', String(location.href).slice(0, 2000));
    params.set('title', String(document.title).slice(0, 300));
    params.set('selector', selectorFor(el).slice(0, 300));
    params.set('text', (el.innerText || '').trim().slice(0, 1000));
    params.set('html', String(el.outerHTML || '').slice(0, 4000));
    finish(params);
  };
  const onKey = (event) => {
    if (event.key !== 'Escape') { return; }
    event.preventDefault();
    event.stopPropagation();
    const params = new URLSearchParams();
    params.set('cancel', '1');
    finish(params);
  };
  document.body.appendChild(overlay);
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
})();";

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
    pub loading: bool,
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
    /// CDP 端口。启动时抽一次，写进 WebView2 的环境参数；非 Windows 或
    /// 端口抽取失败时为 None，agent 操控面就不存在，浏览器本体不受影响。
    devtools_port: Option<u16>,
    /// 拾取武装位：browser_pick_element 装上标签 id，该标签的下一次哨兵导航
    /// 才被承认，用后即焚 —— 页面伪造哨兵导航时这里没武装，直接丢弃。
    picking: Mutex<Option<u32>>,
}

impl BrowserHost {
    /// 抽一个 127.0.0.1 上的空闲端口给 CDP 用。
    ///
    /// 只能启动时抽：端口要进 WebView2 的环境参数，而环境在第一个 webview
    /// 创建时定型。绑定成功即释放，端口在释放与内核启动之间存在被其他进程
    /// 抢走的窗口 —— 抢走时这一次启动没有 agent 操控面，属于已声明的限制。
    #[must_use]
    pub fn new() -> Self {
        let devtools_port = if cfg!(windows) {
            match std::net::TcpListener::bind(("127.0.0.1", 0)) {
                Ok(listener) => listener.local_addr().map(|address| address.port()).ok(),
                Err(error) => {
                    log::warn!("browser devtools port was not allocated: {error}");
                    None
                }
            }
        } else {
            None
        };

        Self {
            devtools_port,
            ..Self::default()
        }
    }

    /// 内核 CDP 端点。playwright-mcp 的 --cdp-endpoint 接的就是它。
    fn devtools_endpoint(&self) -> Option<String> {
        self.devtools_port
            .map(|port| format!("http://127.0.0.1:{port}"))
    }

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
                    loading: tab.loading,
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

/// 内核报来的装载进度：Started 亮转圈，Finished 熄掉。
///
/// 只记装载，不动活动标签：内核眼里 CDP 导航与页面自刷新都是无命令导航，
/// 据此换活动标签就是从用户手里抢焦点。要不要跟着 agent 走是面板那一侧的
/// 意图（browser-panel-store 的自动展开），静音位在那里。
fn note_loading(app: &AppHandle, id: u32, loading: bool) {
    {
        let host = app.state::<BrowserHost>();
        lock(&host.tabs).note_loading(id, loading);
    }

    publish(app);
}

/// 拾取结果：喂给渲染层，落进对话草稿。tab_id 取宿主闭包里的标签号，
/// 不信页面自报的任何身份。
#[derive(Clone, Debug, Deserialize, Serialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct BrowserElementPicked {
    pub tab_id: u32,
    pub url: String,
    pub title: String,
    pub selector: String,
    pub text: String,
    pub html: String,
}

/// 字段长度的二次鉗制：拾取脚本已截过，这里不信它。按字符截，UTF-8 安全。
fn clamp_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

/// 解除一个标签的拾取武装。真实导航走这里；重复拾取由新武装覆盖。
fn disarm_pick(app: &AppHandle, id: u32) {
    let host = app.state::<BrowserHost>();
    let mut picking = lock(&host.picking);

    if *picking == Some(id) {
        *picking = None;
    }
}

/// 哨兵导航到站：验武装、拆 query、发事件。
///
/// 只认「browser_pick_element 之后该标签的第一次哨兵导航」，用后即焚 ——
/// 没武装就是页面伪造，丢弃。字段经 url crate 的 query_pairs 自动百分号
/// 解码，编解码零手搓（页面侧是浏览器原生 URLSearchParams）。
fn finish_pick(app: &AppHandle, id: u32, target: &Url) {
    let armed = {
        let host = app.state::<BrowserHost>();
        let mut picking = lock(&host.picking);

        if *picking == Some(id) {
            *picking = None;
            true
        } else {
            false
        }
    };

    if !armed {
        log::warn!("browser tab {id} offered a pick payload while unarmed; dropped");
        return;
    }

    let mut cancelled = false;
    let mut url = String::new();
    let mut title = String::new();
    let mut selector = String::new();
    let mut text = String::new();
    let mut html = String::new();

    for (key, value) in target.query_pairs() {
        match key.as_ref() {
            "cancel" => cancelled = true,
            "url" => url = clamp_chars(&value, 2000),
            "title" => title = clamp_chars(&value, 300),
            "selector" => selector = clamp_chars(&value, 300),
            "text" => text = clamp_chars(&value, 1000),
            "html" => html = clamp_chars(&value, 4000),
            _ => {}
        }
    }

    if cancelled {
        return;
    }

    let picked = BrowserElementPicked {
        tab_id: id,
        url,
        title,
        selector,
        text,
        html,
    };

    if let Err(error) = picked.emit(app) {
        log::warn!("browser element pick was not delivered: {error}");
    }
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

    if let Some(webview) = existing {
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
    let load_handle = app.clone();
    let open_handle = app.clone();

    let builder = WebviewBuilder::new(
        format!("{LABEL_PREFIX}{id}"),
        WebviewUrl::External(url.clone()),
    )
    .data_directory(profile)
    .on_navigation(move |target| {
        /* 哨兵导航是拾取回传，不是真的要去哪：吃掉它，页面原地不动。 */
        if target.as_str().starts_with(PICK_SENTINEL) {
            finish_pick(&nav_handle, id, target);
            return false;
        }

        /* 真实导航解除拾取武装：拾取脚本随旧文档一起消失了。 */
        disarm_pick(&nav_handle, id);
        note_url(&nav_handle, id, target.as_str());
        true
    })
    .on_document_title_changed(move |_webview, title| {
        note_title(&title_handle, id, title.as_ref());
    })
    .on_page_load(move |_webview, payload| {
        note_loading(
            &load_handle,
            id,
            matches!(payload.event(), tauri::webview::PageLoadEvent::Started),
        );
    })
    .on_new_window(move |target, _features| {
        // 页面里的 window.open 收编成新标签。在这个回调里同步建 webview 会
        // 在 Windows 上死锁（回调占着 WebView2 的线程），所以拒掉原生窗口，
        // 异步把同一个地址开进标签条。
        let handle = open_handle.clone();
        let address = target.to_string();

        tauri::async_runtime::spawn(async move {
            browser_open_tab(handle, Some(address)).await;
        });

        tauri::webview::NewWindowResponse::Deny
    });

    // CDP 端口是环境级参数：第一个 webview 创建时环境定型，之后同 profile
    // 的实例共用。默认的 msWebOOUI 关闭项要一并带上 —— additional_browser_args
    // 是整体替换，不是追加。
    #[cfg(windows)]
    let builder = match app.state::<BrowserHost>().devtools_port {
        Some(port) => builder.additional_browser_args(&format!(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={port}"
        )),
        None => builder,
    };

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

/// 开标签。不带地址就是空白页。
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
        tabs.close(id)
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

/// 「打开调试工具」：WebView2 的 DevTools 独立窗口。
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

/// 内核 CDP 端点，mcp.json 对账用。非 Windows 或端口没抽到时为 None。
#[command]
#[specta::specta]
pub async fn browser_devtools_endpoint(app: AppHandle) -> Option<String> {
    app.state::<BrowserHost>().devtools_endpoint()
}

/// 「选择网页元素加入聊天」：给标签装上拾取武装并注入拾取脚本。
///
/// 空白页没有内核实例，run_in_page 自然是空操作，什么也不会发生。
#[command]
#[specta::specta]
pub async fn browser_pick_element(app: AppHandle, id: u32) {
    {
        let host = app.state::<BrowserHost>();
        *lock(&host.picking) = Some(id);
    }

    run_in_page(&app, id, PICKER_SCRIPT);
}

/// 把内核预热出来，让 CDP 端点上有页面可听。
///
/// 已有活的 webview 或没有端口时是空操作。有带地址的标签就驱动第一个；
/// 一个都没有就预热一页空白页 —— agent 拿到的是真实内核里的真实页面。
pub fn ensure_live_kernel(app: &AppHandle) {
    {
        let host = app.state::<BrowserHost>();

        if host.devtools_port.is_none() || !lock(&host.webviews).is_empty() {
            return;
        }
    }

    let driven = {
        let host = app.state::<BrowserHost>();
        let tabs = lock(&host.tabs);

        tabs.entries().iter().find_map(|tab| {
            tab.url
                .as_deref()
                .and_then(|value| Url::parse(value).ok())
                .map(|url| (tab.id, url))
        })
    };

    if let Some((id, url)) = driven {
        drive(app, id, &url);
        apply_layout(app);
        publish(app);
        return;
    }

    let id = {
        let host = app.state::<BrowserHost>();
        let mut tabs = lock(&host.tabs);
        tabs.open(None)
    };

    let Ok(url) = Url::parse(poietica_browser_native::BLANK_PAGE) else {
        return;
    };

    drive(app, id, &url);
    apply_layout(app);
    publish(app);
}
