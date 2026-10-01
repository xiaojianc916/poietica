pub mod commands;
pub(crate) mod host;
pub(crate) mod mcp_server;
pub(crate) use host::AutomationHost;

use std::sync::{Arc, OnceLock};

use crate::error::{Error, Result};

static AUTOMATION: OnceLock<Arc<AutomationHost>> = OnceLock::new();
static MCP: OnceLock<Arc<mcp_server::AutomationMcpServer>> = OnceLock::new();

pub(crate) fn open_automation(host: Arc<AutomationHost>) -> Result<()> {
    AUTOMATION
        .set(host)
        .map_err(|_| Error::Internal("the scheduler was already opened".to_owned()))
}

pub(crate) fn automation() -> Result<Arc<AutomationHost>> {
    AUTOMATION
        .get()
        .cloned()
        .ok_or_else(|| Error::Internal("the scheduler is not up".to_owned()))
}

/// 调度器对外的 MCP 面；退出时要先把它的监听关掉。
pub(crate) fn open_mcp(server: Arc<mcp_server::AutomationMcpServer>) -> Result<()> {
    MCP.set(server)
        .map_err(|_| Error::Internal("the MCP server was already opened".to_owned()))
}

pub(crate) fn mcp() -> Result<Arc<mcp_server::AutomationMcpServer>> {
    MCP.get()
        .cloned()
        .ok_or_else(|| Error::Internal("the automation MCP server is not up".to_owned()))
}
