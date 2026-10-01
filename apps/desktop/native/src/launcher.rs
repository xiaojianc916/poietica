//! 把裸程序名解析成本机能启动的启动式；平台事实与唯一解析处在 crates/process-host/src/program.rs。

use serde::Serialize;
use specta::Type;

use poietica_agent_client::resolve_launcher;
use poietica_problem::Problem;

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpLauncher {
    pub program: String,
    pub prefix_args: Vec<String>,
}

#[specta::specta]
pub async fn launcher_resolve(program: String) -> Result<Option<McpLauncher>, Problem> {
    Ok(resolve_launcher(&program).map(|launcher| McpLauncher {
        program: launcher.program,
        prefix_args: launcher.prefix_args,
    }))
}
