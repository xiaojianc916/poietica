//! 窗口的宿主面：生命周期、几何状态与托盘。窗口的 IPC 命令在
//! ipc::commands::window，这里只放常驻进程、不进命令清单的那一块。

pub mod lifecycle;
pub mod state;
pub mod tray;

pub use lifecycle::WindowMaximized;
pub use state::{MAIN_WINDOW, WINDOW_STATE_FLAGS};
pub use tray::TerminationRequested;
