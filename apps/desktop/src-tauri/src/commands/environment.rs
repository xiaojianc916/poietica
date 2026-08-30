//! 这个 agent 自己那份 mcp.json —— 谁都能读，写只认受控 home。
//!
//! 判据只有一条：我们启动的那个进程会不会读它。这条判据不是这里发明的，
//! `profile.rs` 的 `agent_config_file` 上面早就写着「读一份它根本不看的文件，等于把
//! 屏幕上因此显示出来的每一行都说成假话」。那里管 config.toml，这里管 mcp.json，
//! 两者是同一个进程按同一个变量找到的同一个家。
//!
//! 所以这里不去翻别家客户端的配置。Cursor 的 ~/.cursor/mcp.json、Claude Desktop 的
//! claude_desktop_config.json、Windsurf 的 ~/.codeium/windsurf/mcp_config.json、
//! Visual Studio 当作全局位置的 %USERPROFILE%\.mcp.json —— 这些位置都真实存在，但
//! Kimi 一个都不读。把它们列到界面上，人拨那个开关不会有任何事情发生。
//!
//! 写的判据再多一条：受控 home 生效。那时这份文件躺在本应用的数据根之下，终端里的
//! CLI 读的是用户自己的家，写它只影响本应用开出去的会话；不受控时写入被拒绝，判据
//! 与 config.toml 那条写路径（`agent_set_default_model`）同源，理由也相同。
//!
//! 也不去解析 mcpServers 的形状：形状的解释归领域层，全仓只有 mcp-config 一处。这里
//! 只交正文、只收正文。写入前唯一的检查是「它得是一份 JSON」—— 那是文件格式本身而
//! 不是形状：一份写坏的文件会让 CLI 把整张服务器表判为无效。

use std::path::Path;

use poietica_extension_native as extension;
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, command};

use crate::commands::agent_setup::profile::{
    agent_mcp_config, agent_mcp_config_for_write, write_config_atomically,
};
use crate::error::{Error, Result};
use poietica_problem::Problem;

type EnvironmentCommandResult<T> = std::result::Result<T, Problem>;

/// 一份配置文件的现状：它在哪，以及它的正文。
///
/// 文件不在时 contents 是 None 而不是空串：一个空文件与一个不存在的文件，界面要
/// 说的话不一样。
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentFile {
    pub location: String,
    pub contents: Option<String>,
}

fn read_file(path: &Path) -> Result<Option<String>> {
    match extension::read_optional(path) {
        Ok(contents) => Ok(contents),
        // 折回 Error::Io 保住原来的对外文案（public_message 表里的「文件操作失败」）。
        Err(extension::ExtensionError::Io(cause)) => Err(Error::from(cause)),
        // read_optional 只做一次 read_to_string，其余变体到不了这里。
        Err(other) => Err(Error::Internal(other.to_string())),
    }
}

/// 默认 agent 会去读的那份 mcp.json。
///
/// # Errors
///
/// 没有默认 agent、档案不存在、家目录算不出来，或文件存在却读不动时返回错误。
#[command]
#[specta::specta]
pub async fn environment_mcp_config(app: AppHandle) -> EnvironmentCommandResult<EnvironmentFile> {
    (|| -> Result<EnvironmentFile> {
        let path = agent_mcp_config(&app)?;

        Ok(EnvironmentFile {
            location: path.to_string_lossy().into_owned(),
            contents: read_file(&path)?,
        })
    })()
    .map_err(Problem::from)
}

/// 改写受控 home 里那份 mcp.json，先比对再落盘。
///
/// expected_contents 是调用方这次读—改—写开始时读到的原文（文件不存在时是 None）。
/// 比不上就拒绝：领域层的改写是整份写回，两个写者并发时，后落盘的那份拿着更旧的
/// 原文，直接写会把前一次的改动静默抹掉。被拒的一方重读一遍再来，谁的改动都不丢。
///
/// 落盘走与 config.toml 同一条原子路径（`write_config_atomically`）：会话随时
/// 可能起来读它，残缺的半份文件不该有被读到的窗口。
///
/// # Errors
///
/// 这家 agent 不受控、正文不是合法 JSON、文件在比对后被别人改过、或写不进去时返回错误。
#[command]
#[specta::specta]
pub async fn environment_mcp_config_write(
    app: AppHandle,
    expected_contents: Option<String>,
    contents: String,
) -> EnvironmentCommandResult<EnvironmentFile> {
    (|| -> Result<EnvironmentFile> {
        let path = agent_mcp_config_for_write(&app)?;

        if let Err(cause) = serde_json::from_str::<serde_json::Value>(&contents) {
            return Err(Error::AgentCli(format!(
                "要写进 mcp.json 的内容不是合法的 JSON：{cause}"
            )));
        }

        if read_file(&path)? != expected_contents {
            return Err(Error::AgentCli(
                "mcp.json 在这次编辑期间被改过，屏幕上那一份已经过时；刷新后再试".to_owned(),
            ));
        }

        write_config_atomically(&path, &contents)?;

        Ok(EnvironmentFile {
            location: path.to_string_lossy().into_owned(),
            contents: Some(contents),
        })
    })()
    .map_err(Problem::from)
}
