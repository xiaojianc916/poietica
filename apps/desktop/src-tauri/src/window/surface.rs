use std::sync::RwLock;

use tauri::{Manager, Theme, Window, utils::config::Color};

use super::state::MAIN_WINDOW;

/// 衬底色。正本是 packages/design-system/src/tokens/palette.css 的
/// `--ui-palette-neutral-75` 与 `--ui-palette-dark-850`，window-surface-policy 核对相等。
const LIGHT_SURFACE: Color = Color(243, 243, 243, 255);
const DARK_SURFACE: Color = Color(32, 32, 32, 255);

/// 衬底是原生窗口与 WebView2 两层，运行期必须与创建期一样成对设置，否则只改到的那层停在创建值。
#[derive(Debug, Default)]
pub struct WindowSurface {
    color: RwLock<Option<Color>>,
}

impl WindowSurface {
    /// 启动时按偏好落定衬底与原生主题，早于窗口第一次被看见。
    ///
    /// 创建期只有 tauri.conf.json 那一个颜色，渲染层的投影要等设置加载与 React 首帧
    /// 才到，中间露出的就是创建值 —— 深色偏好配浅色创建值，那一瞬就是浅色底。
    ///
    /// 主题也必须一起钉：文档层的 `--window-backing-surface` 预运行初稿读的是
    /// prefers-color-scheme，不钉就跟着系统走，与偏好脱钩，页面自己刷成浅色。
    ///
    /// `theme` 为 `None` 即跟随系统，与 `Window::set_theme` 同义；落定后回读
    /// 平台解析结果，高对比度等例外由 tao 裁决，这里不重算。返回实际落定的主题。
    pub fn adopt(&self, window: &Window, theme: Option<Theme>) -> tauri::Result<Theme> {
        window.set_theme(theme)?;

        let resolved = window.theme()?;

        self.set(
            window,
            if resolved == Theme::Dark {
                DARK_SURFACE
            } else {
                LIGHT_SURFACE
            },
        )?;

        Ok(resolved)
    }

    pub fn set(&self, window: &Window, color: Color) -> tauri::Result<()> {
        let mut current = self
            .color
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *current = Some(color);

        apply(window, color)
    }

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

/// 主窗口挂了子 webview 后 get_webview_window 返回 None，只能按 label 直取主 webview。
fn apply(window: &Window, color: Color) -> tauri::Result<()> {
    window.set_background_color(Some(color))?;

    if let Some(webview) = window.app_handle().get_webview(MAIN_WINDOW) {
        webview.set_background_color(Some(color))
    } else {
        log::warn!("main webview not found; the WebView2 surface stays at its creation color");

        Ok(())
    }
}
