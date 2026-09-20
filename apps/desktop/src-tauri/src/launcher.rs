//! 把裸程序名解析成本机能启动的启动式；平台事实与唯一解析处在 crates/kap-client/src/process/program.rs。

use serde::Serialize;
use specta::Type;
use tauri::command;

use poietica_kap_client::resolve_launcher;

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpLauncher {
    pub program: String,
    pub prefix_args: Vec<String>,
}

#[command]
#[specta::specta]
pub async fn launcher_resolve(program: String) -> Option<McpLauncher> {
    resolve_launcher(&program).map(|launcher| McpLauncher {
        program: launcher.program,
        prefix_args: launcher.prefix_args,
    })
}
