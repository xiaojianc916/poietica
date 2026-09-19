/*
 * release 产物必须是 windows 子系统：缺这一行，安装后双击 Poietica.exe 会先弹一个
 * 黑色控制台窗口（Tauri 官方模板自 v1 起每个 main.rs 的第一行就是它）。debug 构建
 * 保留控制台，cargo run 与 tauri dev 的日志不受影响。
 */
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    poietica_desktop_lib::run();
}
