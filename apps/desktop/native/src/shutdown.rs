//! 退出的那一趟：把持有的东西按相反的顺序放掉，放完才真的退。
//!
//! Tauri 时代这是 `RunEvent::ExitRequested` 里的一次 prevent_exit —— 宿主的退出事件
//! 会发很多次（关窗口、托盘退出、系统注销），所以要一道 Once 保证只排空一次。
//! Electron 时代退出由主进程的 `before-quit` 发起，语义没变：主进程调 `shutdown()`，
//! 这里放完再让它退。
//!
//! 顺序即不变量：先停收活（调度器不再接新任务），再停执行（MCP 服务、会话连接），
//! 最后才是那些只读的东西。反过来会让一次退出变成一串超时。

use std::sync::Once;

use crate::automation::AutomationHost;
use crate::automation::mcp_server::AutomationMcpServer;

static DRAINED: Once = Once::new();

/// 主进程在 `before-quit` 里调它。
pub fn run() {
    drain();
}

/// 排空一次。第二次调用直接返回 —— 退出路径会被走很多遍。
pub fn drain() {
    DRAINED.call_once(|| {
        // 先停收活，再停执行 —— 反过来会让一次退出变成一串超时。
        if let Ok(automation) = crate::automation::automation() {
            stop::<AutomationHost>(Some(automation.as_ref()), "the automation scheduler");
        }

        if let Ok(mcp) = crate::automation::mcp() {
            stop::<AutomationMcpServer>(Some(mcp.as_ref()), "the automation MCP server");
        }

        if let Ok(runtime) = crate::conversation::runtime()
            && let Err(error) = runtime.shutdown()
        {
            log::error!("shutdown: the agent connection did not retire: {error}");
        }
    });
}

/// 停止某一项。没起来的那一项不算失败：进程可能在启动的半路上就退了。
fn stop<T>(holder: Option<&T>, what: &str)
where
    T: Stoppable,
{
    let Some(holder) = holder else {
        return;
    };

    if let Err(error) = holder.stop() {
        log::error!("shutdown: {what} did not stop: {error}");
    }
}

/// 能被停下来的东西：调度器回 `io::Result`，MCP 服务也回 `io::Result`。
trait Stoppable {
    fn stop(&self) -> std::io::Result<()>;
}

impl Stoppable for AutomationHost {
    fn stop(&self) -> std::io::Result<()> {
        AutomationHost::shut_down(self)
    }
}

impl Stoppable for AutomationMcpServer {
    fn stop(&self) -> std::io::Result<()> {
        AutomationMcpServer::shut_down(self)
    }
}
