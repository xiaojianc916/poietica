//! 托盘只做显示、隐藏、请求退出；退出是请求，确认权归渲染层。
//!
//! 强制退出这件事由组合根注入：退出屏障归 shutdown，而托盘是窗口的一块，
//! 让窗口反向认识退出屏障，就把「谁先谁后」的裁决权留在了叶子节点上。

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use tauri_plugin_window_state::AppHandleExt;
use tauri_specta::Event;

use super::state::{MAIN_WINDOW, WINDOW_STATE_FLAGS};

const TRAY_ID: &str = "poietica-tray";
const MENU_SHOW: &str = "poietica-tray-show";
const MENU_HIDE: &str = "poietica-tray-hide";
const MENU_QUIT: &str = "poietica-tray-quit";
const MENU_FORCE_QUIT: &str = "poietica-tray-force-quit";

/// 丢弃未保存更改的那条退出路。由组合根交给托盘，托盘不认识退出屏障本身。
pub type ForceQuit = Arc<dyn Fn(&AppHandle) + Send + Sync>;

#[derive(Clone, Copy, Debug, Deserialize, Event, Serialize, Type)]
pub struct TerminationRequested;

pub fn install(app: &AppHandle, force_quit: ForceQuit) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, MENU_SHOW, "显示窗口", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, MENU_HIDE, "隐藏到托盘", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "退出程序", true, None::<&str>)?;
    let force_quit_item = MenuItem::with_id(
        app,
        MENU_FORCE_QUIT,
        "强制退出（丢弃未保存的更改）",
        true,
        None::<&str>,
    )?;
    let menu = Menu::with_items(app, &[&show, &hide, &separator, &quit, &force_quit_item])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Poietica")
        .menu(&menu)
        // Windows convention: left click activates, right click opens the menu.
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| on_menu_event(app, event, &force_quit))
        .on_tray_icon_event(on_tray_icon_event);

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    let _tray = builder.build(app)?;
    Ok(())
}

fn on_menu_event(app: &AppHandle, event: MenuEvent, force_quit: &ForceQuit) {
    match event.id().as_ref() {
        MENU_SHOW => show_main(app),
        MENU_HIDE => hide_main(app),
        MENU_QUIT => request_termination(app),
        MENU_FORCE_QUIT => {
            log::warn!("tray: force quit requested; unsaved work is discarded");
            force_quit(app);
        }
        other => log::debug!("unhandled tray menu id: {other}"),
    }
}

fn on_tray_icon_event(tray: &tauri::tray::TrayIcon, event: TrayIconEvent) {
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
    } = event
    {
        toggle_main(tray.app_handle());
    }
}

fn request_termination(app: &AppHandle) {
    // 先把窗口叫出来：确认对话框画在一个隐藏的窗口里等于没有对话框。
    show_main(app);

    if let Err(error) = TerminationRequested.emit(app) {
        log::warn!("tray: could not deliver the termination request: {error}");
    }
}

fn toggle_main(app: &AppHandle) {
    let Some(window) = app.get_window(MAIN_WINDOW) else {
        return;
    };

    match (window.is_visible(), window.is_minimized()) {
        (Ok(true), Ok(false)) => match window.is_focused() {
            Ok(true) => hide_main(app),
            _ => show_main(app),
        },
        _ => show_main(app),
    }
}

pub(crate) fn show_main(app: &AppHandle) {
    let Some(window) = app.get_window(MAIN_WINDOW) else {
        log::warn!("tray: main window is gone, nothing to show");
        return;
    };

    super::lifecycle::activate(&window);
}

fn hide_main(app: &AppHandle) {
    let Some(window) = app.get_window(MAIN_WINDOW) else {
        return;
    };

    // 隐藏前先存几何：进程在托盘里被杀也能恢复位置。
    persist_window_state(app);

    if let Err(error) = window.hide() {
        log::warn!("tray: hide failed: {error}");
    }
}

fn persist_window_state(app: &AppHandle) {
    if let Err(error) = app.save_window_state(WINDOW_STATE_FLAGS) {
        log::debug!("tray: could not save window state: {error}");
    }
}
