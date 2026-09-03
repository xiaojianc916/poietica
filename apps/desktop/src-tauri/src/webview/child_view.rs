use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};

use super::bounds::apply_layout;
use super::bridge::{
    BrowserHost, browser_open_tab, fetch_icon, note_loading, note_title, note_url, publish,
};
use super::lock;
use super::picker_bridge::{disarm_picker, finish_pick};
use crate::window::MAIN_WINDOW;

/// 子 webview 的 label 前缀。capability 按窗口配给 "main"，但这些 webview
/// 永远是外部 origin，remote 未声明即无 IPC —— 前缀只用于归属与调试。
const LABEL_PREFIX: &str = "browser-";

const PICKER_SCRIPT: &str = include_str!(concat!(env!("OUT_DIR"), "/element-picker.js"));

/// 给一个标签一台真的内核：不存在则创建，存在则导航。
///
/// 懒创建是刻意的：空白页没有 webview，也就没有任何加载与内存开销。
pub(super) fn drive(app: &AppHandle, id: u32, url: &Url) {
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

    let source = if url.scheme() == "file" {
        WebviewUrl::CustomProtocol(url.clone())
    } else {
        WebviewUrl::External(url.clone())
    };
    let builder = WebviewBuilder::new(format!("{LABEL_PREFIX}{id}"), source)
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
                if let Err(error) = browser_open_tab(handle, Some(address)).await {
                    log::warn!("browser popup was rejected: {error:?}");
                }
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

pub(super) fn run_in_page(app: &AppHandle, id: u32, script: &str) -> bool {
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

    /* 预热不开新标签：没有标签就没有要预热的东西。 */
    let Some((id, address)) = target else {
        return;
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
