use poietica_problem::Problem;
use tauri::{AppHandle, Manager, command, utils::config::Color};

use crate::{
    error::{Error, Result},
    window::{MAIN_WINDOW, WindowSurface},
};

/// 记录并应用主窗口的 native backing surface。
///
/// 一条宿主命令承接 renderer 的主题投影；恢复路径读取同一状态，避免把窗口生命周期
/// 建立在 renderer 是否仍能及时提交 IPC 上。
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
            .get_webview_window(MAIN_WINDOW)
            .ok_or_else(|| Error::NotFound("main window".to_owned()))?;

        app.state::<WindowSurface>()
            .set(&window, Color(red, green, blue, 255))?;

        Ok(())
    })()
    .map_err(Problem::from)
}

/// 打开开发者工具。
///
/// 窗口已经不在了就什么也不做 —— 一个关掉的窗口没有开发者工具可开，那不是故障。
///
/// 不返回 `Result`：每条路径都是 Ok(())，那个返回值到了生成绑定里只是一个渲染层
/// 必须接、且永远接到 null 的东西。
///
/// 发行构建同样带开发者工具。真正的闸在根 Cargo.toml：tauri 的 devtools feature
/// 只在 debug 构建里自动开，不显式写上它，这个方法在发行构建里根本不存在。
#[command]
#[specta::specta]
pub async fn window_open_devtools(app: AppHandle, label: String) {
    if let Some(window) = app.get_webview_window(&label) {
        window.open_devtools();
    }
}

/// 把一个外部 URL 交给系统默认浏览器。没有 `JavaScript` 对应物的两个之二。
///
/// 主窗口是 decorations: false，没有地址栏也没有后退按钮。让 webview 自己导航
/// 到外站，等于把应用替换成一个回不来的浏览器 —— 用户只能去杀进程。所以渲染层
/// 里所有 http(s) 链接都在 capture 阶段被拦下，改走这里。
///
/// 协议白名单在渲染层（chrome/external-links.ts）先过一遍，这里
/// 再过一遍：一条能把任意字符串交给系统 shell 的命令，不能只靠调用方自律。
///
/// 打不开一个链接不是故障，不中断调用方：拒掉一个非 web 协议、以及系统浏览器没能
/// 打开，都各自记进原生日志。不返回 `Result` 的理由与上一条命令相同。
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
