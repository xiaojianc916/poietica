//! Windows-first system tray integration.
//!
//! 托盘只做三件事：显示窗口、隐藏窗口、请求退出。
//!
//! 它不决定应用能不能退出。未保存的工作属于应用层，所以"退出程序"发出的是一个
//! 请求：渲染层收到后走与关闭按钮完全相同的确认流程，确认完再销毁窗口。关闭按钮
//! 的拦截权同样归渲染层。

use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_window_state::AppHandleExt;

use super::app::{MAIN_WINDOW, WINDOW_STATE_FLAGS};

const TRAY_ID: &str = "poietica-tray";
const MENU_SHOW: &str = "poietica-tray-show";
const MENU_HIDE: &str = "poietica-tray-hide";
const MENU_QUIT: &str = "poietica-tray-quit";
const MENU_FORCE_QUIT: &str = "poietica-tray-force-quit";

/// 与渲染层之间唯一的退出契约。
pub const TERMINATION_REQUESTED_EVENT: &str = "poietica://termination-requested";

/// Installs the tray icon and its menu. Called once from the composition root.
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, MENU_SHOW, "显示窗口", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, MENU_HIDE, "隐藏到托盘", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "退出程序", true, None::<&str>)?;
    // 前端完全无响应（例如停在崩溃屏上）时的出路。它是破坏性的，所以它是
    // 用户看得见、点得到的一个动作，而不是一个替用户做决定的倒计时。
    let force_quit = MenuItem::with_id(
        app,
        MENU_FORCE_QUIT,
        "强制退出（丢弃未保存的更改）",
        true,
        None::<&str>,
    )?;
    let menu = Menu::with_items(app, &[&show, &hide, &separator, &quit, &force_quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Poietica")
        .menu(&menu)
        // Windows convention: left click activates, right click opens the menu.
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(on_tray_icon_event);

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    let _tray = builder.build(app)?;
    Ok(())
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        MENU_SHOW => show_main(app),
        MENU_HIDE => hide_main(app),
        MENU_QUIT => request_termination(app),
        MENU_FORCE_QUIT => force_quit(app),
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

/// 发出退出请求。销毁窗口是渲染层确认之后的事。
fn request_termination(app: &AppHandle) {
    // 先把窗口叫出来：确认对话框画在一个隐藏的窗口里等于没有对话框。
    show_main(app);

    if let Err(error) = app.emit(TERMINATION_REQUESTED_EVENT, ()) {
        log::warn!("tray: could not deliver the termination request: {error}");
    }

    // 到此为止。窗口还在不在，不是原生侧该替用户回答的问题 —— 它最常见的
    // 含义是确认框还开着，或者用户点了取消。
}

/// 不问确认，立刻结束进程。只由托盘上那条显式的菜单项发起。
///
/// 排空归退出屏障：托盘不自己存几何、也不自己调 exit。
fn force_quit(app: &AppHandle) {
    log::warn!("tray: force quit requested; unsaved work is discarded");

    super::shutdown::drain(app, 0);
}

fn toggle_main(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };

    match (window.is_visible(), window.is_minimized()) {
        (Ok(true), Ok(false)) => match window.is_focused() {
            // Visible and focused: a second click tucks it away again.
            Ok(true) => hide_main(app),
            _ => show_main(app),
        },
        _ => show_main(app),
    }
}

pub(crate) fn show_main(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        log::warn!("tray: main window is gone, nothing to show");
        return;
    };

    crate::commands::window::activate(&window);
}

fn hide_main(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };

    // Geometry is saved before hiding, so a later restore keeps the position
    // even if the process is killed while sitting in the tray.
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
