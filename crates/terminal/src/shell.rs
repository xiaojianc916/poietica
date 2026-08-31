//! 这台机器上的交互 shell：从环境读，不猜路径。

use std::ffi::OsString;
use std::path::PathBuf;

/// 一条可启动的交互 shell。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Shell {
    pub program: PathBuf,
    pub args: Vec<String>,
}

/// Unix 的 SHELL 与 Windows 的 ComSpec 是各自平台文档化的那一个变量。
#[cfg(windows)]
const VARIABLE: &str = "ComSpec";
#[cfg(not(windows))]
const VARIABLE: &str = "SHELL";

/// 环境没写时的落点：POSIX 保证 /bin/sh 存在，Windows 上 cmd.exe 在搜索路径上。
#[cfg(windows)]
const FALLBACK: &str = "cmd.exe";
#[cfg(not(windows))]
const FALLBACK: &str = "/bin/sh";

impl Shell {
    /// 用户自己的 shell。
    #[must_use]
    pub fn user() -> Self {
        Self::from_environment(std::env::var_os(VARIABLE))
    }

    fn from_environment(configured: Option<OsString>) -> Self {
        let program = configured
            .filter(|value| !value.is_empty())
            .map_or_else(|| PathBuf::from(FALLBACK), PathBuf::from);

        Self {
            program,
            args: login_args(),
        }
    }
}

/// macOS 上以登录 shell 启动：Dock 与 Finder 起的 GUI 进程不经过登录 shell，
/// 拿不到用户 PATH 里包管理器与版本管理器写的那几段。
#[cfg(target_os = "macos")]
fn login_args() -> Vec<String> {
    vec!["-l".to_owned()]
}

#[cfg(not(target_os = "macos"))]
fn login_args() -> Vec<String> {
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
}
