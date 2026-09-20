use std::sync::RwLock;

use serde::{Deserialize, Serialize};
use tauri::{Manager, Theme, Window, utils::config::Color};

use super::state::MAIN_WINDOW;
use crate::settings::ThemePreference;

/// 衬底色。正本是 packages/design-system/src/tokens/palette.css 的
/// `--ui-palette-neutral-75` 与 `--ui-palette-dark-850`，window-surface-policy 核对相等。
const LIGHT_SURFACE: Color = Color(243, 243, 243, 255);
const DARK_SURFACE: Color = Color(32, 32, 32, 255);

/// 宿主裁决过的主题：偏好为 `System` 时它是系统此刻那一档，与渲染层的
/// `ResolvedTheme` 同形。定义在这里而不是浏览器桥，是因为解钉与回读都发生在这一层。
#[derive(Clone, Copy, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum ResolvedTheme {
    Light,
    Dark,
}

/// 衬底是原生窗口与 WebView2 两层，运行期必须与创建期一样成对设置，否则只改到的那层停在创建值。
#[derive(Debug, Default)]
pub struct WindowSurface {
    color: RwLock<Option<Color>>,
}

impl WindowSurface {
    /// 偏好 → 原生主题。`System` 给 `None`，与 `Window::set_theme` 的「跟随系统」同义。
    ///
    /// 启动落定与运行期切换共用这一处映射：两份映射迟早分叉，而分叉的表现正是
    /// 「跟随系统」解出上一个偏好。
    pub fn native_theme(preference: ThemePreference) -> Option<Theme> {
        match preference {
            ThemePreference::Light => Some(Theme::Light),
            ThemePreference::Dark => Some(Theme::Dark),
            ThemePreference::System => None,
        }
    }

    /// 按偏好落定衬底与原生主题。启动时早于窗口第一次被看见，运行期是切换偏好的那一跳。
    ///
    /// 创建期只有 tauri.conf.json 那一个颜色，渲染层的投影要等设置加载与 React 首帧
    /// 才到，中间露出的就是创建值 —— 深色偏好配浅色创建值，那一瞬就是浅色底。
    ///
    /// 主题必须一起钉：文档层的 `prefers-color-scheme` 由原生主题推出来，不钉就与偏好脱钩。
    /// 反过来说，偏好改回 `System` 时必须**解钉**（`set_theme(None)`），否则那一层停在
    /// 上一个偏好上，渲染层读到的「系统」其实是上一档 —— 运行期切换因此也走这一条路，
    /// 不另开第二条写路径。
    ///
    /// 落定后回读平台解析结果，高对比度等例外由 tao 裁决，这里不重算。返回实际落定的主题。
    pub fn adopt(&self, window: &Window, theme: Option<Theme>) -> tauri::Result<ResolvedTheme> {
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

        Ok(if resolved == Theme::Dark {
            ResolvedTheme::Dark
        } else {
            ResolvedTheme::Light
        })
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

#[cfg(test)]
mod tests {
    #![allow(
        clippy::unwrap_used,
        reason = "a broken literal in a fixture must fail the test loudly"
    )]

    use super::{ResolvedTheme, WindowSurface};
    use crate::settings::ThemePreference;
    use tauri::Theme;

    /*
     * `System` 必须映射成 `None`（解钉）。映射成上一档正是本模块要修的那个缺陷：
     * 原生主题不解钉，文档层的 prefers-color-scheme 就停在上一个偏好上，
     * 渲染层读到的「系统」不是系统。
     */
    #[test]
    fn system_unpins_the_native_theme() {
        assert_eq!(WindowSurface::native_theme(ThemePreference::System), None);
        assert_eq!(
            WindowSurface::native_theme(ThemePreference::Dark),
            Some(Theme::Dark)
        );
        assert_eq!(
            WindowSurface::native_theme(ThemePreference::Light),
            Some(Theme::Light)
        );
    }

    /* 回读结果与渲染层的词汇同形：`light`/`dark` 两个小写字面量。 */
    #[test]
    fn resolved_theme_matches_the_renderer_vocabulary() {
        assert_eq!(
            serde_json::to_string(&ResolvedTheme::Light).unwrap(),
            "\"light\""
        );
        assert_eq!(
            serde_json::to_string(&ResolvedTheme::Dark).unwrap(),
            "\"dark\""
        );
    }
}
