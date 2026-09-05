//! Application-owned exit barrier. Completion means the drain has returned.

use std::sync::Once;

use tauri::{AppHandle, Manager, RunEvent, command};
use tauri_plugin_window_state::AppHandleExt;

use crate::automation::mcp_server::AutomationMcpServer;
use crate::conversation::runtime::AgentRuntime;
use crate::window::WINDOW_STATE_FLAGS;

#[derive(Debug)]
pub(crate) struct ShutdownBarrier {
    drained: Once,
}

impl Default for ShutdownBarrier {
    fn default() -> Self {
        Self {
            drained: Once::new(),
        }
    }
}

pub fn on_run_event(app: &AppHandle, event: RunEvent) {
    if let RunEvent::ExitRequested { api, code, .. } = event
        && !app.state::<ShutdownBarrier>().drained.is_completed()
    {
        api.prevent_exit();
        drain(app);
        app.exit(code.unwrap_or(0));
    }
}

/// Renderer-facing application exit. Every exit entry converges on the drain barrier.
#[command]
#[specta::specta]
pub async fn application_quit(app: AppHandle) {
    quit(&app);
}

pub fn quit(app: &AppHandle) {
    drain(app);
    app.exit(0);
}

pub fn relaunch(app: &AppHandle) -> ! {
    drain(app);
    app.restart()
}

fn drain(app: &AppHandle) {
    app.state::<ShutdownBarrier>().drained.call_once(|| {
        if let Err(error) = app.save_window_state(WINDOW_STATE_FLAGS) {
            log::debug!("shutdown: could not save window state: {error}");
        }
        app.state::<poietica_git_adapter_native::WatchRegistry>()
            .clear();
        if let Err(error) = app.state::<AutomationMcpServer>().stop() {
            log::error!("shutdown: automation MCP did not drain: {error}");
        }
        if let Err(error) = app.state::<crate::automation::AutomationHost>().stop() {
            log::error!("shutdown: automation scheduler did not stop: {error}");
        }
        if let Err(error) = app.state::<AgentRuntime>().shutdown() {
            log::error!("shutdown: the agent connection did not retire: {error}");
        }
    });
}
