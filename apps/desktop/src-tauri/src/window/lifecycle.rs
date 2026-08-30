//! 主窗口的生老病死：恢复几何、约束到可视区、呈现看门狗、带到前台。
//!
//! 呈现权归渲染层：窗口在 React 首帧提交后由前端 present()。这里的看门狗只是
//! 兜底 —— webview 若根本没跑起来（脚本 404、CSP 拦截、渲染进程启动失败），
//! 没有它窗口会永远不可见，进程只存在于任务管理器里。

use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{Manager, WebviewWindow, WindowEvent, async_runtime};
use tauri_plugin_window_state::WindowExt;
use tauri_specta::Event;

use super::state::WINDOW_STATE_FLAGS;

/// 渲染层没能呈现时的兜底期限。
const PRESENT_WATCHDOG: std::time::Duration = std::time::Duration::from_secs(8);

/// 窗口最大化态的一次翻转。
#[derive(Clone, Copy, Debug, Deserialize, Event, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WindowMaximized {
    pub is_maximized: bool,
}

/// 承接 skip_initial_state：初始几何恢复的责任在这里，不在插件。
///
/// 窗口此刻还不可见（tauri.conf.json 的 visible: false），所以恢复位置和
/// 尺寸不会被看到，用户第一次看见它时它已经在正确的地方。restore_state
/// 期间插件持有恢复锁，其间产生的 Moved / Resized 不会被当成用户操作写
/// 回缓存 —— 这也是宁可调插件自己的恢复、而不是手写 set_position 的原因。
///
/// 首次启动没有状态文件，恢复是空操作，此时生效的正是 center: true。
pub fn restore_initial_geometry(window: &WebviewWindow) -> tauri::Result<()> {
    window.restore_state(WINDOW_STATE_FLAGS)?;
    constrain_to_visible_area(window);

    Ok(())
}

/// 让窗口自己播报最大化态。
///
/// tao 只发 Resized，不发 Maximized，所以判定必须在这一侧做；去抖之后过边界的只有
/// 真正的翻转。渲染层若改成在每次 Resized 上问一遍 is_maximized，缩放的每一帧就是
/// 一次 IPC 往返加一次重渲 —— 而那正是拖拽期间不能抢的那条线程。
pub fn watch_maximized(window: &WebviewWindow) {
    let emitter = window.clone();
    let broadcast = AtomicBool::new(window.is_maximized().unwrap_or(false));

    window.on_window_event(move |event| {
        if !matches!(event, WindowEvent::Resized(_)) {
            return;
        }

        /* 窗口不可被合成时不播报。最小化与隐藏同样发 Resized，而那一刻的
         * is_maximized 不是用户的意图；播出去，还原后的头几帧就带着错的标题栏。 */
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

/// 把一个已经呈现过的主窗口带到前台。托盘、单实例与呈现看门狗的唯一入口。
///
/// 每次调用只发必要的那几个原生状态变更。SW_RESTORE 对最大化窗口是「还原到原
/// 尺寸」而不是空操作（Win32 ShowWindow），无条件发它会把最大化的窗口降下来；
/// 而每一次多余的状态变更都是一次窗口重新合成，WebView2 的表面还没提交时，那
/// 一帧画出来的是窗口衬底 —— 用户看到的就是整窗闪一下。
pub fn activate(window: &WebviewWindow) {
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

/// 渲染层超时未呈现时，把窗口亮出来。
pub fn present_watchdog(window: WebviewWindow) {
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

/// 把窗口约束回它所在显示器的可视范围内。
///
/// 几何有两个来源。磁盘上的状态文件由 window-state 插件负责，它自己会把恢复出
/// 的位置约束回显示器，那条路径是安全的。没有被任何人检查过的是另一条：
/// tauri.conf.json 里的默认值。1400x900 在一台 1366x768 的笔记本上放不下，而
/// 居中会把它摆在 y = -86，标题栏落到工作区上方 —— 窗口是 decorations: false，
/// 没有原生系统菜单可以用键盘把它拖回来，于是首次启动就是一个拖不动的窗口。
///
/// 这里只做约束，不做决定：几何本来就成立时它是空操作。最大化与全屏跳过，
/// 那两种状态下的尺寸本来就等于显示器。
fn constrain_to_visible_area(window: &WebviewWindow) {
    if window.is_maximized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false) {
        return;
    }

    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };

    let monitor_size = *monitor.size();
    let monitor_position = *monitor.position();

    /*
     * 95% 是任务栏的替代品，不是它的测量值。work_area 的语义各平台不一致，而
     * 这里要的只是"别铺满整块屏、别顶到边缘之外"，不需要像素级贴合。
     */
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
