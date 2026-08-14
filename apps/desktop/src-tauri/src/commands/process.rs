//! 起子进程时的那一处平台细节。
//!
//! GUI 进程 spawn 一个控制台程序时，Windows 会给它开一个窗口：刷新一次模型清单就
//! 闪一次黑框，添加一次 provider 再闪一次。唯一的解法是 `CREATE_NO_WINDOW`。
//!
//! 起子进程的管线不止一条（`agent_setup::cli` 与 `agent_setup::install`），同一个
//! 平台细节只该有一处，所以它在这里而不是在各自的调用点上。git 那条管线住在
//! native crate（crates/git，不依赖组合根），另有一份 —— 正本在那边改动时，
//! 这份注释要跟着改。
//!
//! Zed 的 crates/util/src/command.rs 对每一条命令都设这个标志，理由相同。

use std::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub(crate) fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        command.creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(not(windows))]
    {
        let _unused = command;
    }
}
