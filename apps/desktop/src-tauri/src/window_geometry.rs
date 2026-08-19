//! 主窗口的可见几何。渲染层的布局模式只认这里发出的尺寸。
//!
//! 最小化时平台把窗口缩到图标尺寸并照常派发 Resized —— 那不是任何人看得见的
//! 几何，在这里就地丢弃，渲染层因此无需也无从再猜宿主状态。

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, WebviewWindow, WindowEvent, command};
use tauri_specta::Event;

/// 逻辑像素宽度，与 CSS 断点同一坐标系。
#[derive(Clone, Copy, Debug, Deserialize, Event, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WindowGeometry {
    pub width: u32,
}

/// 最小化、或尺寸不可读时为空。
fn visible_geometry(window: &WebviewWindow) -> Option<WindowGeometry> {
    if window.is_minimized().unwrap_or(false) {
        return None;
    }

    let scale = window.scale_factor().ok()?;

    Some(WindowGeometry {
        width: window.inner_size().ok()?.to_logical::<u32>(scale).width,
    })
}

/// 把主窗口的几何变化接到事件面上。
pub fn observe(window: &WebviewWindow) {
    let source = window.clone();
    let handle = window.app_handle().clone();

    window.on_window_event(move |event| {
        if !matches!(event, WindowEvent::Resized(_)) {
            return;
        }

        if let Some(geometry) = visible_geometry(&source)
            && let Err(error) = geometry.emit(&handle)
        {
            log::warn!("could not emit window geometry: {error}");
        }
    });
}

/// 首帧要用的那一次快照，此后全部走事件。
#[command]
#[specta::specta]
pub async fn window_geometry(app: AppHandle, label: String) -> Option<WindowGeometry> {
    app.get_webview_window(&label)
        .as_ref()
        .and_then(visible_geometry)
}
