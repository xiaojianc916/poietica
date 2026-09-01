//! 当前平台的交互 shell 解析与启动参数。

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// 一条可启动的交互 shell。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Shell {
    pub program: PathBuf,
    pub args: Vec<String>,
}

/// Unix 从 SHELL 读用户配置；Windows 的 ComSpec 只作 PowerShell 缺席时的兜底。
#[cfg(windows)]
const VARIABLE: &str = "ComSpec";
#[cfg(not(windows))]
const VARIABLE: &str = "SHELL";

/// 平台兜底只在用户配置和 Windows 首选项都不可用时使用。
#[cfg(windows)]
const FALLBACK: &str = "cmd.exe";
#[cfg(not(windows))]
const FALLBACK: &str = "/bin/sh";

impl Shell {
    /// 默认交互 shell。
    #[must_use]
    pub fn user() -> Self {
        #[cfg(windows)]
        if let Some(program) = ["pwsh.exe", "powershell.exe"]
            .into_iter()
            .find_map(|name| which::which(name).ok())
        {
            return Self::from_environment(Some(program.into_os_string()));
        }

        Self::from_environment(std::env::var_os(VARIABLE))
    }

    fn from_environment(configured: Option<OsString>) -> Self {
        let program = configured
            .filter(|value| !value.is_empty())
            .map_or_else(|| PathBuf::from(FALLBACK), PathBuf::from);

        let args = shell_args(&program);

        Self { program, args }
    }
}

/// macOS 登录 shell 读取用户 PATH。
#[cfg(target_os = "macos")]
fn shell_args(_program: &Path) -> Vec<String> {
    vec!["-l".to_owned()]
}

/// 保留 PowerShell profile 以加载 PSReadLine，只隐藏启动横幅。
#[cfg(windows)]
fn shell_args(program: &Path) -> Vec<String> {
    let powershell = program
        .file_stem()
        .and_then(|stem| stem.to_str())
        .is_some_and(|stem| {
            stem.eq_ignore_ascii_case("pwsh") || stem.eq_ignore_ascii_case("powershell")
        });

    if powershell {
        vec!["-NoLogo".to_owned()]
    } else {
        Vec::new()
    }
}

#[cfg(all(not(target_os = "macos"), not(windows)))]
fn shell_args(_program: &Path) -> Vec<String> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "测试内的失败就该当场炸")]

    use super::{FALLBACK, Shell};
    use std::ffi::OsString;
    use std::path::PathBuf;

    #[test]
    fn an_absent_or_empty_environment_falls_back_to_the_platform_shell() {
        assert_eq!(
            Shell::from_environment(None).program,
            PathBuf::from(FALLBACK)
        );
        assert_eq!(
            Shell::from_environment(Some(OsString::new())).program,
            PathBuf::from(FALLBACK)
        );
    }

    #[test]
    fn a_configured_shell_is_taken_as_is() {
        assert_eq!(
            Shell::from_environment(Some(OsString::from("/usr/bin/fish"))).program,
            PathBuf::from("/usr/bin/fish")
        );
    }

    #[cfg(windows)]
    #[test]
    fn powershell_loads_profiles_without_a_startup_banner() {
        for program in ["pwsh.exe", "powershell.exe"] {
            let shell = Shell::from_environment(Some(OsString::from(program)));

            assert_eq!(shell.args, vec!["-NoLogo".to_owned()]);
        }
    }
}
