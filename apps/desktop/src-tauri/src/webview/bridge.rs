use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Url, command};
use tauri_specta::Event;

use super::bounds::apply_layout;
use super::child_view::{drive, run_in_page};
use super::picker_bridge::{stop_picker, stop_picker_unless};
use super::{PICKER_CANCEL_SCRIPT, lock};
use crate::error::Error;
use poietica_problem::Problem;

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
    pub(super) tabs: Mutex<poietica_browser_native::Tabs>,
    pub(super) webviews: Mutex<HashMap<u32, tauri::Webview>>,
    pub(super) bounds: Mutex<PanelBounds>,
    pub(super) visible: Mutex<bool>,
    /// CDP 端口。启动时抽一次，写进 WebView2 的环境参数；非 Windows 或
    /// 端口抽取失败时为 None，agent 操控面就不存在，浏览器本体不受影响。
    pub(super) devtools_port: Option<u16>,
    pub(super) picker: Mutex<poietica_browser_native::Picker>,
    /// 上一次真正下发给内核的摆放。相等就不再下发 —— 一次拖拽每帧都经过这里。
    pub(super) placed: Mutex<HashMap<u32, Placement>>,
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

/// 每次变更后广播快照。发不出去只说明还没有订阅者，不是故障。
pub(super) fn publish(app: &AppHandle) {
    let state = app.state::<BrowserHost>().snapshot();

    if let Err(error) = state.emit(app) {
        log::warn!("browser-state event could not be delivered: {error}");
    }
}

/// 内核报来的导航（用户点了链接、重定向都走这里）。
pub(super) fn note_url(app: &AppHandle, id: u32, url: &str) {
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
pub(super) fn fetch_icon(app: &AppHandle, page: &str) {
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
pub(super) fn note_title(app: &AppHandle, id: u32, title: &str) {
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
pub(super) fn note_loading(app: &AppHandle, id: u32, loading: bool) {
    {
        let host = app.state::<BrowserHost>();
        lock(&host.tabs).note_loading(id, loading);
    }

    publish(app);
}

#[command]
#[specta::specta]
/// 渲染层进面板时拉一次的初始快照。之后靠事件。
pub(crate) async fn browser_state(app: AppHandle) -> BrowserState {
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

#[command]
#[specta::specta]
pub async fn browser_print(app: AppHandle, id: u32) -> Result<(), Problem> {
    let webview = {
        let host = app.state::<BrowserHost>();
        lock(&host.webviews).get(&id).cloned()
    }
    .ok_or_else(|| Error::NotFound("browser tab".to_owned()))?;

    webview.eval("window.print()").map_err(Error::from)?;
    Ok(())
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
