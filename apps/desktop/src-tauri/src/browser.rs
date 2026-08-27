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
//!   · 空白页没有画面 —— 预热出的内核实例始终隐藏，新标签页由渲染层画。
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

const PICKER_SCRIPT: &str = include_str!(concat!(env!("OUT_DIR"), "/element-picker.js"));
const PICKER_CANCEL_SCRIPT: &str = "window.__poieticaElementPicker?.cancel();";

/// 面板视口在主窗口客户区里的逻辑坐标。渲染层量 DOM，这里只收数。
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize, specta::Type)]
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
    /// 站点图标的 data URL。缺席时渲染层画地球。
    pub favicon: Option<String>,
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
    pub picking_tab_id: Option<u32>,
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
    picker: Mutex<poietica_browser_native::Picker>,
    /// 上一次真正下发给内核的摆放。相等就不再下发 —— 一次拖拽每帧都经过这里。
    placed: Mutex<HashMap<u32, Placement>>,
}

/// 一个标签此刻该在哪：Some 是摆在这个矩形上并呈现，None 是隐藏。
type Placement = Option<PanelBounds>;

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
        let (tabs, active_tab_id, recently_closed) = {
            let model = lock(&self.tabs);
            let tabs = model
                .entries()
                .iter()
                .map(|tab| BrowserTab {
                    id: tab.id,
                    url: tab.url.clone(),
                    title: tab.title.clone(),
                    loading: tab.loading,
                    favicon: model.icon(tab.id).map(str::to_owned),
                })
                .collect();
            let recently_closed = model
                .recently_closed()
                .map(|closed| BrowserClosedTab {
                    url: closed.url.clone(),
                    title: closed.title.clone(),
                })
                .collect();
            (tabs, model.active_id(), recently_closed)
        };
        let picking_tab_id = lock(&self.picker).active_tab_id();

        BrowserState {
            tabs,
            active_tab_id,
            picking_tab_id,
            recently_closed,
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

    fetch_icon(app, url);
    publish(app);
}

/// 取一页的站点图标，落进模型。
///
/// 两个触发点对应两个事件源：我们发起的导航（drive）与页面发起的导航
/// （note_url）；图标按来源存一份，has_icon 让重复触发与同源第二个标签免费。
///
/// 走 HTTP 而不是内核的图标事件：WebView2 的 FaviconChanged 只能经 COM 拿，
/// 而根 Cargo.toml 是 unsafe_code = "deny"，那条路在这个仓库里不存在。
/// 失败只是没有图标，不打断任何操作。
fn fetch_icon(app: &AppHandle, page: &str) {
    let Some((origin, probe)) = poietica_browser_native::icon_probe(page) else {
        return;
    };

    let known = {
        let host = app.state::<BrowserHost>();
        lock(&host.tabs).has_icon(&origin)
    };

    if known {
        return;
    }

    let handle = app.clone();

    tauri::async_runtime::spawn(async move {
        let Ok(client) = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
        else {
            return;
        };

        let Ok(response) = client.get(&probe).send().await else {
            return;
        };

        if !response.status().is_success() {
            return;
        }

        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned();

        let Ok(bytes) = response.bytes().await else {
            return;
        };

        let Some(icon) = poietica_browser_native::icon_data_url(&content_type, &bytes) else {
            return;
        };

        {
            let host = handle.state::<BrowserHost>();
            lock(&host.tabs).note_icon(origin, icon);
        }

        publish(&handle);
    });
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

#[derive(Clone, Copy, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum BrowserPickSubmission {
    Attach,
    Send,
}

#[derive(Clone, Debug, Deserialize, Serialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct BrowserElementPicked {
    pub tab_id: u32,
    pub submission: BrowserPickSubmission,
    pub url: String,
    pub title: String,
    pub tag_name: String,
    pub selector: Option<String>,
    pub role: String,
    pub aria_label: String,
    pub text: String,
    pub html: String,
    pub styles: String,
    pub component_name: String,
    pub source_file: String,
    pub source_line: Option<u32>,
    pub source_column: Option<u32>,
    pub stack: String,
    pub style_changes: String,
    pub comment: String,
    pub picked_at: String,
}

fn stop_picker(app: &AppHandle, tab_id: Option<u32>) -> bool {
    let lease = {
        let host = app.state::<BrowserHost>();
        let mut picker = lock(&host.picker);
        match tab_id {
            Some(id) => picker.cancel(id),
            None => picker.cancel_active(),
        }
    };
    let Some(lease) = lease else {
        return false;
    };
    let _ = run_in_page(app, lease.tab_id(), PICKER_CANCEL_SCRIPT);
    true
}

fn stop_picker_unless(app: &AppHandle, tab_id: u32) {
    let active = lock(&app.state::<BrowserHost>().picker).active_tab_id();
    if active.is_some() && active != Some(tab_id) {
        stop_picker(app, None);
    }
}

fn disarm_picker(app: &AppHandle, tab_id: u32) {
    let host = app.state::<BrowserHost>();
    let _ = lock(&host.picker).cancel(tab_id);
}

fn finish_pick(app: &AppHandle, tab_id: u32, target: &Url) {
    let Some(outcome) = poietica_browser_native::decode_picker_callback(target) else {
        log::warn!("browser tab {tab_id} returned an invalid picker payload");
        return;
    };
    let accepted = {
        let host = app.state::<BrowserHost>();
        lock(&host.picker).finish(tab_id, outcome.token())
    };
    if !accepted {
        log::warn!("browser tab {tab_id} returned a stale picker payload");
        return;
    }

    if let poietica_browser_native::PickOutcome::Submitted {
        submission,
        element,
        ..
    } = outcome
    {
        let picked = BrowserElementPicked {
            tab_id,
            submission: match submission {
                poietica_browser_native::PickSubmission::Attach => BrowserPickSubmission::Attach,
                poietica_browser_native::PickSubmission::Send => BrowserPickSubmission::Send,
            },
            url: element.url,
            title: element.title,
            tag_name: element.tag_name,
            selector: element.selector,
            role: element.role,
            aria_label: element.aria_label,
            text: element.text,
            html: element.html,
            styles: element.styles,
            component_name: element.component_name,
            source_file: element.source_file,
            source_line: element.source_line,
            source_column: element.source_column,
            stack: element.stack,
            style_changes: element.style_changes,
            comment: element.comment,
            picked_at: element.picked_at,
        };
        if let Err(error) = picked.emit(app) {
            log::warn!("browser element pick was not delivered: {error}");
        }
    }
    publish(app);
}

/// 让「哪个 webview 可见」追上「哪个标签活动」。
///
/// 只有屏幕上那一页（活动且有地址）的 webview 呈现并占住面板视口；其余隐藏。
/// 面板收起时全部隐藏。
/// 这是唯一一处决定可见性的代码 —— 命令们只改状态，然后一律走这里。
fn apply_layout(app: &AppHandle) {
    let host = app.state::<BrowserHost>();

    /* 一段：锁内算出计划并与上次下发对账，锁内一次都不碰内核。 */
    let plan: Vec<(tauri::Webview, u32, Placement)> = {
        let visible = *lock(&host.visible);
        let bounds = *lock(&host.bounds);
        let showing = lock(&host.tabs).showing();
        let webviews = lock(&host.webviews);
        let mut placed = lock(&host.placed);

        placed.retain(|id, _| webviews.contains_key(id));

        webviews
            .iter()
            .filter_map(|(id, webview)| {
                let wanted = (visible && Some(*id) == showing).then(|| PanelBounds {
                    width: bounds.width.max(1.0),
                    height: bounds.height.max(1.0),
                    ..bounds
                });

                (placed.insert(*id, wanted) != Some(wanted)).then(|| (webview.clone(), *id, wanted))
            })
            .collect()
    };

    /* 二段：锁外下发。内核调用在 Windows 上会泵消息，锁内下发会重入回这里。 */
    for (webview, id, wanted) in plan {
        let outcome = match wanted {
            Some(rect) => webview
                .set_position(LogicalPosition::new(rect.x, rect.y))
                .and_then(|()| webview.set_size(LogicalSize::new(rect.width, rect.height)))
                .and_then(|()| webview.show()),
            None => webview.hide(),
        };

        /* 下发失败就撤销记账，下一趟重试 —— 不留一个假的「已经摆好了」。 */
        if let Err(error) = outcome {
            log::warn!("browser tab {id} layout was not applied: {error}");
            lock(&host.placed).remove(&id);
        }
    }
}

/// 给一个标签一台真的内核：不存在则创建，存在则导航。
///
/// 懒创建是刻意的：空白页没有 webview，也就没有任何加载与内存开销。
fn drive(app: &AppHandle, id: u32, url: &Url) {
    fetch_icon(app, url.as_str());

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
    .initialization_script(PICKER_SCRIPT)
    .on_navigation(move |target| {
        /* 哨兵导航是拾取回传，不是真的要去哪：吃掉它，页面原地不动。 */
        if poietica_browser_native::is_picker_callback(target) {
            finish_pick(&nav_handle, id, target);
            return false;
        }

        disarm_picker(&nav_handle, id);
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
    stop_picker(&app, None);
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
    stop_picker(&app, Some(id));
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
    stop_picker_unless(&app, id);
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

    stop_picker(&app, Some(id));

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
    if stop_picker(&app, Some(id)) {
        publish(&app);
    }
    run_in_page(&app, id, "history.back()");
}

#[command]
#[specta::specta]
pub async fn browser_forward(app: AppHandle, id: u32) {
    if stop_picker(&app, Some(id)) {
        publish(&app);
    }
    run_in_page(&app, id, "history.forward()");
}

#[command]
#[specta::specta]
pub async fn browser_reload(app: AppHandle, id: u32) {
    if stop_picker(&app, Some(id)) {
        publish(&app);
    }
    run_in_page(&app, id, "location.reload()");
}

fn run_in_page(app: &AppHandle, id: u32, script: &str) -> bool {
    let webview = {
        let host = app.state::<BrowserHost>();
        lock(&host.webviews).get(&id).cloned()
    };
    let Some(webview) = webview else {
        return false;
    };
    if let Err(error) = webview.eval(script) {
        log::warn!("browser tab {id} rejected injected JavaScript: {error}");
        return false;
    }
    true
}

/// 重开最近关闭下拉里的第 index 条。
#[command]
#[specta::specta]
pub async fn browser_reopen_closed(app: AppHandle, index: u32) {
    stop_picker(&app, None);
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
    if !visible && stop_picker(&app, None) {
        publish(&app);
    }
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

/// 显式设置当前标签的元素选择模式；状态只归 BrowserHost。
#[command]
#[specta::specta]
pub async fn browser_set_element_picker(app: AppHandle, id: u32, enabled: bool) {
    if !enabled {
        if stop_picker(&app, Some(id)) {
            publish(&app);
        }
        return;
    }

    let has_webview = lock(&app.state::<BrowserHost>().webviews).contains_key(&id);
    if !has_webview {
        return;
    }

    if let Some(previous) = lock(&app.state::<BrowserHost>().picker).cancel_active() {
        let _ = run_in_page(&app, previous.tab_id(), PICKER_CANCEL_SCRIPT);
    }
    let lease = lock(&app.state::<BrowserHost>().picker).start(id);
    let script = format!("window.__poieticaElementPicker.start({});", lease.token());
    if !run_in_page(&app, id, &script) {
        let _ = lock(&app.state::<BrowserHost>().picker).finish(id, lease.token());
    }
    publish(&app);
}

/// 把内核预热出来，让 CDP 端点上有页面可听。
///
/// 已有活的 webview 或没有端口时是空操作。优先给一个带地址的标签配内核，
/// 否则给现有的那一格空白页配 —— agent 随后导航它，屏幕上就是那一格。
pub fn ensure_live_kernel(app: &AppHandle) {
    {
        let host = app.state::<BrowserHost>();

        if host.devtools_port.is_none() || !lock(&host.webviews).is_empty() {
            return;
        }
    }

    let target = {
        let host = app.state::<BrowserHost>();
        let tabs = lock(&host.tabs);

        tabs.entries()
            .iter()
            .find(|tab| tab.url.is_some())
            .or_else(|| tabs.entries().first())
            .map(|tab| (tab.id, tab.url.clone()))
    };

    /* 预热不开新标签、不换活动标签：它只是给已有的那一格配一台内核。 */
    let (id, address) = if let Some(found) = target {
        found
    } else {
        let host = app.state::<BrowserHost>();
        let mut tabs = lock(&host.tabs);

        (tabs.open(None), None)
    };

    let Ok(url) = Url::parse(
        address
            .as_deref()
            .unwrap_or(poietica_browser_native::BLANK_PAGE),
    ) else {
        return;
    };

    drive(app, id, &url);
    apply_layout(app);
    publish(app);
}
