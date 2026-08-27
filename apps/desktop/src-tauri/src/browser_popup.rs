//! 面板浮层的原生表面。
//!
//! 页面是主窗口的原生子 webview（`browser.rs`），原生表面永远合成在宿主窗口的
//! HTML 之上。浮层因此只能是另一个原生窗口。
//!
//! 这个窗口不持有浏览器状态：它订阅同一条 `BrowserState` 广播，动作调同一批命令。

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::bootstrap::app::MAIN_WINDOW;

const POPUP_WINDOW: &str = "browser-popup";
const POPUP_DOCUMENT: &str = "browser-popup.html";

/// 打开浮层。锚点与尺寸是主窗口客户区的逻辑坐标，与视口矩形同一套坐标系。
///
/// 每次打开都新建、关闭即销毁：菜单本来就是一次性表面，这样不必维护复用状态，
/// 也让它永远是最后创建的那个原生表面。
#[tauri::command]
#[specta::specta]
pub async fn open_browser_popup(
    app: AppHandle,
    kind: String,
    theme: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) {
    dismiss(&app);

    let Some(main) = app.get_webview_window(MAIN_WINDOW) else {
        log::warn!("browser popup: main window is gone");
        return;
    };

    let (Ok(position), Ok(scale)) = (main.inner_position(), main.scale_factor()) else {
        log::warn!("browser popup: main window geometry is unavailable");
        return;
    };

    let origin = position.to_logical::<f64>(scale);
    let document = format!("{POPUP_DOCUMENT}?kind={kind}&theme={theme}");

    let built = WebviewWindowBuilder::new(&app, POPUP_WINDOW, WebviewUrl::App(document.into()))
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .inner_size(width, height)
        .position(origin.x + x, origin.y + y)
        .focused(true)
        .build();

    match built {
        Ok(window) => {
            let handle = app.clone();

            /* 失焦即关闭：菜单的通行约定，渲染层因此不必自己盯全局点击。 */
            window.on_window_event(move |event| {
                if matches!(event, WindowEvent::Focused(false)) {
                    dismiss(&handle);
                }
            });
        }
        Err(error) => log::warn!("browser popup: could not build the surface: {error}"),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn close_browser_popup(app: AppHandle) {
    dismiss(&app);
}

/// 关不掉一个菜单不是调用方要接的错误 —— 与托盘对窗口操作同一条纪律：记日志。
fn dismiss(app: &AppHandle) {
    let Some(window) = app.get_webview_window(POPUP_WINDOW) else {
        return;
    };

    if let Err(error) = window.destroy() {
        log::warn!("browser popup: could not dismiss the surface: {error}");
    }
}
