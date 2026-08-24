/*
 * Windows 子系统声明。
 *
 * 缺这一行，release 产物是 console 子系统二进制：安装后双击 Poietica.exe 会先
 * 弹一个黑色控制台窗口。Tauri 官方模板自 v1 起每个 main.rs 的第一行就是它，
 * 本仓库此前一直没有 —— 开发模式下终端本来就在，所以这个缺口在 bun run dev 里
 * 永远不会暴露。
 *
 * debug 构建保留控制台，cargo run 与 tauri dev 的日志不受影响。
 */
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    poietica_desktop_lib::run();
}
