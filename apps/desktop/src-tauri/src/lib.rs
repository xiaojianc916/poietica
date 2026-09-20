#![allow(
    clippy::needless_pass_by_value,
    reason = "Tauri command signatures are consumed by generated IPC handlers"
)]
#![allow(
    clippy::unused_async,
    reason = "async dispatches a command onto the async runtime; sync would run it on the main thread"
)]

pub mod agent;
pub mod asset;
pub mod asset_protocol;
pub(crate) mod automation;
pub(crate) mod composition;
pub mod conversation;
pub mod diagnostics;
pub mod error;
pub mod extension;
pub(crate) mod ipc;
pub mod launcher;
pub mod ledger;
pub(crate) mod library;
pub mod paths;
pub mod review;
pub mod settings;
pub mod shutdown;
pub mod skills;
pub mod terminal;
pub mod webview;
pub mod window;
pub mod workspace;

pub use error::{Error, Result};
pub use ipc::export_bindings::export_ipc_bindings;

#[allow(
    clippy::exit,
    reason = "the generated Tauri context expands to an exit this crate never writes"
)]
#[allow(
    clippy::expect_used,
    reason = "the desktop entry point cannot recover from a failed Tauri event loop"
)]
pub fn run() {
    composition::build()
        .build(tauri::generate_context!())
        .expect("failed to start poietica desktop")
        .run(shutdown::on_run_event);
}
