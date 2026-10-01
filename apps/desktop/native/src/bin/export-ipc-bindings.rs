//! 把命令面导出成 TypeScript 绑定。
//!
//! 跑法：`cargo run -p poietica --bin export-ipc-bindings`（tools/contract/generate-ipc.ts 编排）。

// 这就是这个可执行文件的产物：一行说写到哪、出错说为什么。它没有被 logger 覆盖
// （不是应用的一部分，跑在构建期），所以 stdout/stderr 正是它的交付面。
#![allow(
    clippy::print_stdout,
    clippy::print_stderr,
    reason = "命令行工具的产物就是 stdout/stderr；它跑在应用之外，没有 logger"
)]

fn main() {
    match poietica::export_ipc_bindings() {
        Ok(path) => println!("ipc bindings written to {}", path.display()),
        Err(message) => {
            eprintln!("ipc bindings failed: {message}");
            std::process::exit(1);
        }
    }
}
