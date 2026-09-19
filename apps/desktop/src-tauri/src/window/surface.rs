use std::sync::RwLock;

use tauri::{Manager, Window, utils::config::Color};

use super::state::MAIN_WINDOW;

/// 主窗口衬底的唯一持有者。
///
/// 衬底是两层独立表面：原生窗口一层、WebView2 一层。创建期
/// （tauri.conf.json 的 backgroundColor）两层一起设，运行期必须同样成对，
/// 否则只改到的那层跟着主题走，另一层停在创建值 —— 深色下拖拽与启动露出的
/// 正是停住的那层。
///
/// 主窗口挂着浏览器子 webview 之后 get_webview_window 返回 None（它要求窗口里
/// 所有 webview 与窗口同名），所以这里按 label 直取主 webview，不经过它。
/// None = 渲染层还没投影过主题，此刻生效的是 tauri.conf.json 的 backgroundColor。
#[derive(Debug, Default)]
pub struct WindowSurface {
    color: RwLock<Option<Color>>,
}

impl WindowSurface {
    pub fn set(&self, window: &Window, color: Color) -> tauri::Result<()> {
        let mut current = self
            .color
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *current = Some(color);

        apply(window, color)
    }

    /// 窗口重新合成后把衬底放回去；渲染层还没投影过就什么都不做。
    pub fn reapply(&self, window: &Window) -> tauri::Result<()> {
        let current = *self
            .color
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        match current {
            Some(color) => apply(window, color),
            None => Ok(()),
        }
    }
}

/// 两层一起设，顺序与 Tauri 的 WebviewWindow::set_background_color 一致。
///
/// WebView2 那层是 DefaultBackgroundColor：内容帧还没提交时露的就是它，所以
/// 它不是窗口层的附属品，是同一件事的另一半。
fn apply(window: &Window, color: Color) -> tauri::Result<()> {
    window.set_background_color(Some(color))?;

    if let Some(webview) = window.app_handle().get_webview(MAIN_WINDOW) {
        webview.set_background_color(Some(color))
    } else {
        /* 静默跳过正是这个缺陷此前藏身的地方：只改到一层，另一层留在创建值。 */
        log::warn!("main webview not found; the WebView2 surface stays at its creation color");

        Ok(())
    }
}
