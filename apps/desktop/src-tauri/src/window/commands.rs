use poietica_problem::Problem;
use tauri::{AppHandle, Manager, command, utils::config::Color};

use crate::{
    error::{Error, Result},
    settings::ThemePreference,
    window::{MAIN_WINDOW, ResolvedTheme, WindowSurface},
};

#[command]
#[specta::specta]
pub async fn window_set_surface(
    app: AppHandle,
    red: u8,
    green: u8,
    blue: u8,
) -> std::result::Result<(), Problem> {
    (|| -> Result<()> {
        let window = app
            .get_window(MAIN_WINDOW)
            .ok_or_else(|| Error::NotFound("main window".to_owned()))?;

        app.state::<WindowSurface>()
            .set(&window, Color(red, green, blue, 255))?;

        Ok(())
    })()
    .map_err(Problem::from)
}

/// 运行期改偏好时落定原生主题，并把宿主回读的解析结果交回渲染层。
///
/// 渲染层自己问不出「系统此刻是哪一档」：`prefers-color-scheme` 由原生主题推出来，
/// 而原生主题是这一跳的结果。让渲染层先读、宿主后钉，读到的就是上一个偏好 ——
/// 「跟随系统」正是这样解出深色的。所以解析归宿主，渲染层只消费返回值。
#[command]
#[specta::specta]
pub async fn window_set_theme(
    app: AppHandle,
    preference: ThemePreference,
) -> std::result::Result<ResolvedTheme, Problem> {
    (|| -> Result<ResolvedTheme> {
        let window = app
            .get_window(MAIN_WINDOW)
            .ok_or_else(|| Error::NotFound("main window".to_owned()))?;

        Ok(app
            .state::<WindowSurface>()
            .adopt(&window, WindowSurface::native_theme(preference))?)
    })()
    .map_err(Problem::from)
}

/// 发行构建同样带 devtools：闸在根 Cargo.toml 的 tauri devtools feature，不显式开就没有。
#[command]
#[specta::specta]
pub async fn window_open_devtools(app: AppHandle, label: String) {
    if let Some(webview) = app.get_webview(&label) {
        webview.open_devtools();
    }
}

/// 协议白名单在渲染层（chrome/external-links.ts）先过一遍，这里再过一遍：能把任意字符串交给系统 shell 的命令不能只靠调用方自律。
#[command]
#[specta::specta]
pub async fn window_open_external_url(url: String) {
    let allowed =
        url.starts_with("http://") || url.starts_with("https://") || url.starts_with("mailto:");

    if !allowed {
        log::warn!("refused to hand a non-web URL to the system browser");

        return;
    }

    if let Err(error) = tauri_plugin_opener::open_url(url.as_str(), None::<&str>) {
        log::warn!("could not hand a link to the system browser: {error}");
    }
}
