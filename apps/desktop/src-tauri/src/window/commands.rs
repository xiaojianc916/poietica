use poietica_problem::Problem;
use tauri::{AppHandle, Manager, command, utils::config::Color};

use crate::{
    error::{Error, Result},
    window::{MAIN_WINDOW, WindowSurface},
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
