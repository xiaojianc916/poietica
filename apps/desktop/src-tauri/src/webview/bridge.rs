use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Url, command};
use tauri_specta::Event;

use super::bounds::apply_layout;
use super::child_view::{drive, ensure_live_kernel, run_in_page};
use super::picker_bridge::{stop_picker, stop_picker_unless};
use super::{PICKER_CANCEL_SCRIPT, lock};
use crate::error::Error;
use crate::window::ResolvedTheme;
use poietica_problem::Problem;

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize, specta::Type)]
pub struct PanelBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl PanelBounds {
    /// 内核不接受零尺寸；收窄只在这一处做，创建与布局两条路共用同一个矩形。
    pub(super) fn clamped(self) -> Self {
        Self {
            width: self.width.max(1.0),
            height: self.height.max(1.0),
            ..self
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTab {
    pub id: u32,
    pub url: Option<String>,
    pub title: String,
    pub loading: bool,
    pub favicon: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowserClosedTab {
    pub url: String,
    pub title: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct BrowserState {
    pub revision: u32,
    pub tabs: Vec<BrowserTab>,
    pub active_tab_id: Option<u32>,
    pub picking_tab_id: Option<u32>,
    pub recently_closed: Vec<BrowserClosedTab>,
}

#[derive(Debug, Default)]

pub struct BrowserHost {
    revision: Mutex<u32>,
    pub(super) tabs: Mutex<poietica_browser_native::Tabs>,
    pub(super) webviews: Mutex<HashMap<u32, tauri::Webview>>,
    /// CDP 的保活 target；不进入用户标签模型与 BrowserState。
    pub(super) standby: Mutex<Option<(tauri::Webview, Arc<Mutex<Option<u32>>>)>>,
    pub(super) warming: AtomicBool,
    pub(super) next_target: AtomicU32,
    pub(super) bounds: Mutex<PanelBounds>,
    pub(super) visible: Mutex<bool>,
    pub(super) devtools_port: Option<u16>,
    pub(super) picker: Mutex<poietica_browser_native::Picker>,
    /// 上一次真正下发给内核的摆放。相等就不再下发 —— 一次拖拽每帧都经过这里。
    pub(super) placed: Mutex<HashMap<u32, Placement>>,
}

type Placement = Option<PanelBounds>;

impl BrowserHost {
    /// 端口只能启动时抽：它要进 WebView2 的环境参数，而环境在第一个 webview 创建时定型。
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
        let revision = *lock(&self.revision);
        self.snapshot_at(revision)
    }

    fn publish_snapshot(&self) -> BrowserState {
        let mut revision = lock(&self.revision);
        *revision = revision.saturating_add(1);
        self.snapshot_at(*revision)
    }

    fn snapshot_at(&self, revision: u32) -> BrowserState {
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
            revision,
            tabs,
            active_tab_id,
            picking_tab_id,
            recently_closed,
        }
    }
}

pub(super) fn publish(app: &AppHandle) {
    let state = app.state::<BrowserHost>().publish_snapshot();

    if let Err(error) = state.emit(app) {
        log::warn!("browser-state event could not be delivered: {error}");
    }
}

pub(super) fn note_url(app: &AppHandle, id: u32, url: &str) {
    {
        let host = app.state::<BrowserHost>();
        let mut tabs = lock(&host.tabs);
        tabs.note_url(id, url);
    }

    fetch_icon(app, url);
    publish(app);
}

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
        if let Some(icon) = poietica_browser_native::fetch_icon_data_url(&probe).await {
            {
                let host = handle.state::<BrowserHost>();
                lock(&host.tabs).note_icon(origin, icon);
            }

            publish(&handle);
        }
    });
}

pub(super) fn note_title(app: &AppHandle, id: u32, title: &str) {
    {
        let host = app.state::<BrowserHost>();
        let mut tabs = lock(&host.tabs);
        tabs.note_title(id, title);
    }

    publish(app);
}

/// 只记装载，不动活动标签：内核眼里 CDP 导航与页面自刷新都是无命令导航，跟走即抢焦点。
pub(super) fn note_loading(app: &AppHandle, id: u32, loading: bool) {
    {
        let host = app.state::<BrowserHost>();
        lock(&host.tabs).note_loading(id, loading);
    }

    publish(app);
}

#[command]
#[specta::specta]
pub(crate) async fn browser_state(app: AppHandle) -> BrowserState {
    app.state::<BrowserHost>().snapshot()
}

fn normalized_url(address: &str) -> Result<String, Error> {
    poietica_browser_native::normalize_address(address)
        .ok_or_else(|| Error::Validation("browser address is not a supported URL".to_owned()))
}

#[command]
#[specta::specta]
pub async fn browser_open_tab(app: AppHandle, url: Option<String>) -> Result<(), Problem> {
    stop_picker(&app, None);
    let normalized = match url.as_deref() {
        Some(value) => Some(normalized_url(value)?),
        None => None,
    };

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
    Ok(())
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

    // 先补保活 target 再关闭最后一页，避免 CDP browser 随最后一个 target 退场。
    ensure_live_kernel(&app);

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

#[command]
#[specta::specta]
pub async fn browser_navigate(app: AppHandle, id: u32, address: String) -> Result<(), Problem> {
    let normalized = normalized_url(&address)?;
    let url = Url::parse(&normalized)
        .map_err(|_| Error::Validation("browser address is not a valid URL".to_owned()))?;

    stop_picker(&app, Some(id));

    let known = {
        let host = app.state::<BrowserHost>();
        let mut tabs = lock(&host.tabs);
        tabs.navigate(id, &normalized)
    };

    if !known {
        return Err(Error::NotFound("browser tab".to_owned()).into());
    }

    drive(&app, id, &url);
    apply_layout(&app);
    publish(&app);
    Ok(())
}

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

/// 内核 CDP 端点，mcp.json 对账用。
#[command]
#[specta::specta]
pub async fn browser_devtools_endpoint(app: AppHandle) -> Option<String> {
    app.state::<BrowserHost>().devtools_endpoint()
}

#[command]
#[specta::specta]
pub async fn browser_set_element_picker(
    app: AppHandle,
    id: u32,
    enabled: bool,
    theme: ResolvedTheme,
) {
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
    let theme = match theme {
        ResolvedTheme::Light => "light",
        ResolvedTheme::Dark => "dark",
    };
    let script = format!(
        "window.__poieticaElementPicker.start({token},'{theme}');",
        token = lease.token()
    );
    if !run_in_page(&app, id, &script) {
        let _ = lock(&app.state::<BrowserHost>().picker).finish(id, lease.token());
    }
    publish(&app);
}
