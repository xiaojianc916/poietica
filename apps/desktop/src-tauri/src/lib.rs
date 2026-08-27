#![allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command signatures are consumed by generated IPC handlers"
)]
/*
 * Synchronous Tauri commands are supported, but they dispatch on the main
 * thread, whereas async commands go to the async runtime. Trivial registry
 * commands are async on purpose, to keep even a short lock off the thread that
 * draws the window.
 */
#![allow(
    clippy::unused_async,
    reason = "async dispatches a command onto the async runtime; sync would run it on the main thread"
)]

pub mod asset_protocol;
mod attachments;
pub mod bootstrap;
pub mod browser;
pub mod browser_popup;
pub mod commands;
pub mod diagnostics;
pub mod error;
pub mod ipc;
pub mod local_index;
pub mod mcp;
pub mod paths;

pub use bootstrap::app;
pub use error::{Error, Result};

/// Single composition root. Called from main.rs.
///
/// # Panics
///
/// Panics when the application cannot be handed to the platform at all, which
/// is a packaging fault rather than a runtime condition.
#[allow(
    clippy::exit,
    reason = "the generated Tauri context expands to an exit this crate never writes"
)]
#[allow(
    clippy::expect_used,
    reason = "the desktop entry point cannot recover from a failed Tauri event loop"
)]
pub fn run() {
    app::build()
        .run(tauri::generate_context!())
        .expect("failed to run poietica desktop");
}
