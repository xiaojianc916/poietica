//! Regenerates TypeScript DTO bindings from Rust document IPC contracts.
//!
//! Usage:
//! cargo run -p poietica --bin export-ipc-bindings

fn main() {
    poietica_desktop_lib::export_ipc_bindings();
}
