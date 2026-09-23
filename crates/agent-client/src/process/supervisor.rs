use super::program::hide_console;

pub(crate) async fn kill_tree(child: &mut tokio::process::Child) -> std::io::Result<()> {
    if child.id().is_none() {
        return Ok(());
    }
    if cfg!(windows)
        && let Some(pid) = child.id()
    {
        let mut command = tokio::process::Command::new("taskkill");
        command.args(["/PID", &pid.to_string(), "/T", "/F"]);
        hide_console(command.as_std_mut());
        let output = command.output().await?;
        if !output.status.success() && child.try_wait()?.is_none() {
            return Err(std::io::Error::other(
                "taskkill could not stop the agent process tree",
            ));
        }
    }
    match child.kill().await {
        Ok(()) => Ok(()),
        Err(error) => match child.try_wait() {
            Ok(Some(_)) => Ok(()),
            _ => Err(error),
        },
    }
}

pub(crate) struct Spawned(pub(crate) tokio::process::Child);

impl Drop for Spawned {
    fn drop(&mut self) {
        let Some(pid) = self.0.id() else {
            return;
        };
        // Normal shutdown awaits kill_tree; this protects unwinding and dropped drivers.
        if cfg!(windows) {
            let mut reaper = std::process::Command::new("taskkill");
            reaper.args(["/PID", &pid.to_string(), "/T", "/F"]);
            reaper
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            hide_console(&mut reaper);
            match reaper.status() {
                Ok(status) if status.success() => {}
                Ok(status) => log::error!("emergency agent tree cleanup exited with {status}"),
                Err(error) => log::error!("emergency agent tree cleanup failed: {error}"),
            }
        }
        if let Err(error) = self.0.start_kill() {
            log::error!("emergency agent cleanup failed: {error}");
        }
    }
}
