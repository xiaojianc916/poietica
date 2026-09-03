use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};

use super::bounds::apply_layout;
use super::bridge::{
    BrowserHost, browser_open_tab, fetch_icon, note_loading, note_title, note_url, publish,
};
use super::lock;
use super::picker_bridge::{disarm_picker, finish_pick};
use crate::window::MAIN_WINDOW;

const LABEL_PREFIX: &str = "browser-";
const STANDBY_LABEL_PREFIX: &str = "browser-standby-";
const STANDBY_POSITION: f64 = -10_000.0;
const PICKER_SCRIPT: &str = include_str!(concat!(env!("OUT_DIR"), "/element-picker.js"));

type TargetIdentity = Arc<Mutex<Option<u32>>>;

fn identity(identity: &TargetIdentity) -> Option<u32> {
    *lock(identity)
}

fn promote_standby(app: &AppHandle, identity: &TargetIdentity, target: &Url) -> Option<u32> {
    if target.as_str() == poietica_browser_native::BLANK_PAGE {
        return None;
    }
    if let Some(id) = self::identity(identity) {
        return Some(id);
    }

    let id = {
        let host = app.state::<BrowserHost>();
        let mut standby = lock(&host.standby);
        let held = standby
            .as_ref()
            .is_some_and(|(_, held)| Arc::ptr_eq(held, identity));
        if !held {
            return self::identity(identity);
        }
        let (webview, _) = standby.take()?;
        let id = lock(&host.tabs).open(Some(target.as_str().to_owned()));
        *lock(identity) = Some(id);
        lock(&host.webviews).insert(id, webview);
        id
    };

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        apply_layout(&handle);
        publish(&handle);
    });
    Some(id)
}

fn create_target(
    app: &AppHandle,
    identity: TargetIdentity,
    label: String,
    url: &Url,
    standby: bool,
) -> Option<tauri::Webview> {
    let Some(window) = app.get_window(MAIN_WINDOW) else {
        log::warn!("browser target has no main window to live in");
        return None;
    };
    let profile = match crate::paths::browser_profile(app) {
        Ok(profile) => profile,
        Err(error) => {
            log::warn!("browser profile directory unavailable: {error}");
            return None;
        }
    };

    let nav_handle = app.clone();
    let nav_identity = Arc::clone(&identity);
    let title_handle = app.clone();
    let title_identity = Arc::clone(&identity);
    let load_handle = app.clone();
    let load_identity = Arc::clone(&identity);
    let open_handle = app.clone();
    let source = if url.scheme() == "file" {
        WebviewUrl::CustomProtocol(url.clone())
    } else {
        WebviewUrl::External(url.clone())
    };
    let builder = WebviewBuilder::new(label, source)
        .data_directory(profile)
        .initialization_script(PICKER_SCRIPT)
        .on_navigation(move |target| {
            if poietica_browser_native::is_picker_callback(target) {
                if let Some(id) = self::identity(&nav_identity) {
                    finish_pick(&nav_handle, id, target);
                }
                return false;
            }
            if let Some(id) = self::identity(&nav_identity)
                .or_else(|| promote_standby(&nav_handle, &nav_identity, target))
            {
                disarm_picker(&nav_handle, id);
                note_url(&nav_handle, id, target.as_str());
            }
            true
        })
        .on_document_title_changed(move |_webview, title| {
            if let Some(id) = self::identity(&title_identity) {
                note_title(&title_handle, id, title.as_ref());
            }
        })
        .on_page_load(move |_webview, payload| {
            if let Some(id) = self::identity(&load_identity) {
                note_loading(
                    &load_handle,
                    id,
                    matches!(payload.event(), tauri::webview::PageLoadEvent::Started),
                );
            }
        })
        .on_new_window(move |target, _features| {
            let handle = open_handle.clone();
            let address = target.to_string();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = browser_open_tab(handle, Some(address)).await {
                    log::warn!("browser popup was rejected: {error:?}");
                }
            });
            tauri::webview::NewWindowResponse::Deny
        });

    #[cfg(windows)]
    let builder = match app.state::<BrowserHost>().devtools_port {
        Some(port) => builder.additional_browser_args(&format!(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={port}"
        )),
        None => builder,
    };

    let bounds = *lock(&app.state::<BrowserHost>().bounds);
    let (position, size) = if standby {
        (
            LogicalPosition::new(STANDBY_POSITION, STANDBY_POSITION),
            LogicalSize::new(1.0, 1.0),
        )
    } else {
        (
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)),
        )
    };

    match window.add_child(builder, position, size) {
        Ok(webview) => {
            if standby && let Err(error) = webview.hide() {
                log::warn!("standby browser target did not hide: {error}");
            }
            Some(webview)
        }
        Err(error) => {
            log::warn!("browser target was not created: {error}");
            None
        }
    }
}

pub(super) fn drive(app: &AppHandle, id: u32, url: &Url) {
    fetch_icon(app, url.as_str());

    let existing = {
        let host = app.state::<BrowserHost>();
        lock(&host.webviews).get(&id).cloned()
    };
    if let Some(webview) = existing {
        if let Err(error) = webview.navigate(url.clone()) {
            log::warn!("browser tab {id} refused to navigate: {error}");
        }
        return;
    }

    let claimed = {
        let host = app.state::<BrowserHost>();
        lock(&host.standby).take().map(|(webview, identity)| {
            *lock(&identity) = Some(id);
            lock(&host.webviews).insert(id, webview.clone());
            webview
        })
    };
    if let Some(webview) = claimed {
        if let Err(error) = webview.navigate(url.clone()) {
            log::warn!("browser tab {id} refused to navigate: {error}");
        }
        return;
    }

    let target = Arc::new(Mutex::new(Some(id)));
    if let Some(webview) = create_target(app, target, format!("{LABEL_PREFIX}{id}"), url, false) {
        lock(&app.state::<BrowserHost>().webviews).insert(id, webview);
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

pub fn ensure_live_kernel(app: &AppHandle) {
    let host = app.state::<BrowserHost>();
    if host.warming.swap(true, Ordering::AcqRel) {
        return;
    }
    let needed = host.devtools_port.is_some()
        && lock(&host.webviews).is_empty()
        && lock(&host.standby).is_none();
    if !needed {
        host.warming.store(false, Ordering::Release);
        return;
    }

    let serial = host.next_target.fetch_add(1, Ordering::Relaxed);
    let identity = Arc::new(Mutex::new(None));
    let created = Url::parse(poietica_browser_native::BLANK_PAGE)
        .ok()
        .and_then(|url| {
            create_target(
                app,
                Arc::clone(&identity),
                format!("{STANDBY_LABEL_PREFIX}{serial}"),
                &url,
                true,
            )
        });
    if let Some(webview) = created {
        *lock(&host.standby) = Some((webview, identity));
    }
    host.warming.store(false, Ordering::Release);
}
