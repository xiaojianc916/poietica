//! 内置浏览器的宿主接线 —— 标签模型（crates/browser）与 WebView2 之间唯一的桥。
//!
//! 数据流一句话：命令改 BrowserHost 里的模型并驱动子 webview；内核回调也只写进
//! 同一个模型；每次变更广播一条 browser-state 全量快照，渲染层只投影，不另记一份。
//!
//! 渲染归 multiwebview：面板区域是主窗口里的原生子 webview（Window::add_child，
//! cargo feature "unstable"），不是 iframe —— X-Frame-Options/frame-ancestors
//! 会把半个互联网挡在 iframe 外面。
//!
//! 隔离是结构性的，不靠自律：浏览器 profile 钉在数据根 browser/profile/
//! （paths::browser_profile）；标签 webview 只加载外部 http(s) 地址，
//! capabilities/main-window.json 没有 remote 声明，外站 origin 调不动任何 IPC；
//! 预热出的内核实例始终隐藏，新标签页由渲染层画。
//!
//! 导航动作依靠状态快照自愈；需要系统表面的动作返回统一错误，调用方不得把
//! “没有发生任何事”伪装成成功。

mod bounds;
pub mod bridge;
mod child_view;
mod picker_bridge;

/// 撤下页面里还在飞的拾取脚本。
pub(super) const PICKER_CANCEL_SCRIPT: &str = "window.__poieticaElementPicker?.cancel();";

pub use bridge::{
    BrowserClosedTab, BrowserHost, BrowserState, BrowserTab, PanelBounds, browser_back,
    browser_close_tab, browser_devtools_endpoint, browser_forward, browser_navigate,
    browser_open_tab, browser_print, browser_reload, browser_reopen_closed, browser_select_tab,
    browser_set_bounds, browser_set_element_picker, browser_set_visible,
};
pub use child_view::ensure_live_kernel;
pub use picker_bridge::{BrowserElementPicked, BrowserPickSubmission};

use std::sync::{Mutex, MutexGuard};

/// 锁中毒等于同伴线程已经炸了；这里的临界区只有内存读写，继续用数据是安全的。
pub(super) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
