//! 子进程的收尸：谁起谁埋。

use super::program::hide_console;

/// 关掉整棵进程树，不只是 Shim 那一层：kimi 在 Windows 上是 .cmd，我们拉起的
/// 直接子进程是 cmd.exe，server 是它再拉起来的；单杀 Shim 会把 server 漏在这台
/// 机器上。unix 的 Shim 是 exec 的脚本，pid 就是 server 自己，kill 就够。
pub(crate) async fn kill_tree(child: &mut tokio::process::Child) {
    if cfg!(windows)
        && let Some(pid) = child.id()
    {
        let pid_text = pid.to_string();

        let mut command = tokio::process::Command::new("taskkill");
        command.args(["/PID", pid_text.as_str(), "/T", "/F"]);
        hide_console(command.as_std_mut());
        let _tree = command.output().await;
    }

    child.kill().await.ok();
}

/// 这条连接起的那个进程，谁起谁埋。
///
/// Drop 里补刀是为了不经过 Shutdown 的退场（握手失败、册子中毒、链路接不回来）：
/// tokio 的 Child 不随句柄一起死，漏一次就在这台机器上留一个占着端口与 home 的
/// kap server。
pub(crate) struct Spawned(pub(crate) tokio::process::Child);

impl Drop for Spawned {
    fn drop(&mut self) {
        /* Windows 上拉起的是转发脚本，server 是它的子进程：单杀它会把 server
        漏下，与 kill_tree 同一个理由。Drop 里不能 await，收尸交给系统。 */
        if cfg!(windows)
            && let Some(pid) = self.0.id()
        {
            let mut reaper = std::process::Command::new("taskkill");

            reaper.args(["/PID", &pid.to_string(), "/T", "/F"]);
            hide_console(&mut reaper);

            let _tree = reaper.spawn();
        }

        let _killed = self.0.start_kill();
    }
}
