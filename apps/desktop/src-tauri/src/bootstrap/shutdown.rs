//! 退出屏障：进程只从这里离场。
//!
//! 排空的顺序归这里：窗口几何落盘 → agent 连接退场（送出 kap 的 shutdown 并刷
//! 帧日志）→ 交还事件循环。托盘的强制退出与关掉最后一个窗口走同一次排空，所以
//! 退出只有一条路径。谁创建谁销毁：这些东西都是组合根建的。

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_window_state::AppHandleExt;

use crate::commands::agent::runtime::AgentRuntime;
use super::app::WINDOW_STATE_FLAGS;

/// 排空完成位。落下之后事件循环才放行。
static DRAINED: AtomicBool = AtomicBool::new(false);

/// 事件循环的回调。退出请求先过屏障，排空之前不放行。
pub fn on_run_event(app: &AppHandle, event: RunEvent) {
    if let RunEvent::ExitRequested { api, code, .. } = event
        && !DRAINED.load(Ordering::Acquire)
    {
        api.prevent_exit();
        drain(app);
        app.exit(code.unwrap_or(0));
    }
}

/// 排空并离场。幂等：第二次进来不做事，退出请求由屏障放行。
/// 不问确认，排空之后离场。
pub fn quit(app: &AppHandle) {
    drain(app);
    app.exit(0);
}

/// 装上更新之后重新启动：与退出共用同一次排空。
pub fn relaunch(app: &AppHandle) -> ! {
    drain(app);
    app.restart()
}

/// 幂等排空：第二次进来什么都不做。
fn drain(app: &AppHandle) {
    if DRAINED.swap(true, Ordering::AcqRel) {
        return;
    }

    if let Err(error) = app.save_window_state(WINDOW_STATE_FLAGS) {
        log::debug!("shutdown: could not save window state: {error}");
    }

    if let Err(error) = app.state::<AgentRuntime>().disconnect() {
        log::error!("shutdown: the agent connection did not retire: {error}");
    }


}
