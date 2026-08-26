use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, WebviewWindow, WindowEvent, command};
use tauri_specta::Event;

/// 打开开发者工具。没有 `JavaScript` 对应物的两个窗口操作之一。
///
/// 渲染层需要的其余能力（show / hide / minimize / maximize / close / destroy /
/// `set_title`）都由 @tauri-apps/api/window 直接提供，权限在
/// capabilities/main-window.json 里声明。此前它们各自被包成一条自定义命令，
/// 其中 `window_destroy` 与 `window_open_devtools` 从未出现在 `invoke_handler` 里，
/// 于是应用退出的第一跳每次都失败，靠渲染层的 catch 兜底才走得下去。
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

/// 窗口最大化态的一次翻转。
#[derive(Clone, Copy, Debug, Deserialize, Event, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WindowMaximized {
    pub is_maximized: bool,
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
