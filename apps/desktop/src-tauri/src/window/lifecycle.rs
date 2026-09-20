use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{Manager, Window, WindowEvent, async_runtime};
use tauri_plugin_window_state::WindowExt;
use tauri_specta::Event;

use super::{WindowSurface, state::WINDOW_STATE_FLAGS};

const PRESENT_WATCHDOG: std::time::Duration = std::time::Duration::from_secs(8);

#[derive(Clone, Copy, Debug, Deserialize, Event, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WindowMaximized {
    pub is_maximized: bool,
}

/// 必须走插件的 restore_state 而不是手写 set_position：恢复锁期间的 Moved/Resized 不会被当成用户操作写回缓存。
pub fn restore_initial_geometry(window: &Window) -> tauri::Result<()> {
    window.restore_state(WINDOW_STATE_FLAGS)?;
    constrain_to_visible_area(window);

    Ok(())
}

/// tao 只发 Resized 不发 Maximized，判定必须在这一侧做。
pub fn watch_maximized(window: &Window) {
    let emitter = window.clone();
    let broadcast = AtomicBool::new(window.is_maximized().unwrap_or(false));

    window.on_window_event(move |event| {
        if !matches!(event, WindowEvent::Resized(_)) {
            return;
        }

        // 最小化与隐藏同样发 Resized，那一刻的 is_maximized 不是用户意图。
        if emitter.is_minimized().unwrap_or(false) || !emitter.is_visible().unwrap_or(false) {
            return;
        }

        let Ok(is_maximized) = emitter.is_maximized() else {
            return;
        };

        if broadcast.swap(is_maximized, Ordering::Relaxed) == is_maximized {
            return;
        }

        if let Err(error) = (WindowMaximized { is_maximized }).emit(emitter.app_handle()) {
            log::warn!("could not emit the window maximized state: {error}");
        }
    });
}

/// 只发必要的原生状态变更：unminimize 走的 SW_RESTORE 对最大化窗口是「还原到原尺寸」（Win32），无条件发会把最大化降下来。
pub fn activate(window: &Window) {
    if let Err(error) = window.state::<WindowSurface>().reapply(window) {
        log::warn!("could not reapply the main window surface: {error}");
    }

    if window.is_minimized().unwrap_or(false)
        && let Err(error) = window.unminimize()
    {
        log::warn!("could not unminimize the main window: {error}");
    }

    if !window.is_visible().unwrap_or(false)
        && let Err(error) = window.show()
    {
        log::warn!("could not show the main window: {error}");

        return;
    }

    if let Err(error) = window.set_focus() {
        log::warn!("could not focus the main window: {error}");
    }
}

pub fn present_watchdog(window: Window) {
    async_runtime::spawn(async move {
        tokio::time::sleep(PRESENT_WATCHDOG).await;

        if window.is_visible().unwrap_or(false) {
            return;
        }

        log::warn!(
            "frontend did not present within {PRESENT_WATCHDOG:?}; showing the window anyway"
        );

        activate(&window);
    });
}

/// tauri.conf.json 的默认几何没有别人约束过；decorations: false 的窗口一旦摆出屏，没有系统菜单拖得回来。
fn constrain_to_visible_area(window: &Window) {
    if window.is_maximized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false) {
        return;
    }

    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };

    let monitor_size = *monitor.size();
    let monitor_position = *monitor.position();

    // 95% 是任务栏的替代品，不是测量值；work_area 的语义各平台不一致。
    let max_width = monitor_size.width.saturating_mul(95) / 100;
    let max_height = monitor_size.height.saturating_mul(95) / 100;

    let Ok(size) = window.outer_size() else {
        return;
    };

    let width = size.width.min(max_width);
    let height = size.height.min(max_height);

    if (width, height) != (size.width, size.height)
        && let Err(error) = window.set_size(tauri::PhysicalSize::new(width, height))
    {
        log::warn!("could not clamp the window to its monitor: {error}");
        return;
    }

    let Ok(position) = window.outer_position() else {
        return;
    };

    let monitor_left = i64::from(monitor_position.x);
    let monitor_top = i64::from(monitor_position.y);
    let monitor_right = monitor_left + i64::from(monitor_size.width);
    let monitor_bottom = monitor_top + i64::from(monitor_size.height);

    let left = i64::from(position.x);
    let top = i64::from(position.y);

    let fits = left >= monitor_left
        && top >= monitor_top
        && left + i64::from(width) <= monitor_right
        && top + i64::from(height) <= monitor_bottom;

    if fits {
        return;
    }

    if let Err(error) = window.center() {
        log::warn!("could not recentre the window on its monitor: {error}");
    }
}
