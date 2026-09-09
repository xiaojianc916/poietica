use std::sync::RwLock;

use tauri::{Window, utils::config::Color};

/// 主窗口衬底的唯一持有者。
///
/// 衬底是窗口层属性，而主窗口挂着浏览器子 webview，get_webview_window 自那以后返回
/// None，所以这里只认 Window。None = 渲染层还没投影过主题，此刻生效的是
/// tauri.conf.json 的 backgroundColor。
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

        window.set_background_color(Some(color))
    }

    /// 窗口重新合成后把衬底放回去；渲染层还没投影过就什么都不做。
    pub fn reapply(&self, window: &Window) -> tauri::Result<()> {
        let current = *self
            .color
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        match current {
            Some(color) => window.set_background_color(Some(color)),
            None => Ok(()),
        }
    }
}
