//! 把裸程序名解析成这台机器上真的能启动的一条启动式。
//!
//! mcp.json 里 stdio 条目的 command 是 kap 那一侧要去 spawn 的程序，裸名字在那里不是
//! 可启动的对象（平台事实与唯一解析处见 crates/agent-runtime/src/program.rs）。所以在
//! 写盘那一刻就把解析结果固化进条目：绝对路径；Windows 的 .cmd/.bat 垫片由 cmd.exe /c
//! 代起 —— VS Code 与 Claude Desktop 的官方 Windows 文档给 stdio MCP 服务器写的也是
//! cmd /c。解不出来条目就不该被写进去。

use serde::Serialize;
use specta::Type;
use tauri::command;

use poietica_agent_runtime_native::resolve_launcher;

/// 一条能直接交给启动器的启动式：程序在哪儿，前面还要垫哪些参数。
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpLauncher {
    pub program: String,
    pub prefix_args: Vec<String>,
}

/// 解析一台 stdio MCP 服务器的启动器；这台机器上没有该程序时是 `None`。
///
/// 返回 `None` 而不是错误：缺程序是那台机器的现状，界面要把这句话说出来，而不是
/// 弹一次错误。
#[command]
#[specta::specta]
pub async fn launcher_resolve(program: String) -> Option<McpLauncher> {
    resolve_launcher(&program).map(|launcher| McpLauncher {
        program: launcher.program,
        prefix_args: launcher.prefix_args,
    })
}
