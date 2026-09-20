//! 标签模型（crates/browser）与 WebView2 之间唯一的桥；外站 origin 调不动任何 IPC —— capabilities/main-window.json 没有 remote 声明。

mod bounds;
pub mod bridge;
mod child_view;
mod picker_bridge;

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
