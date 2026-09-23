//! agent 运行时的安装与更新：包管理器归属、最新版查询、一次安装的执行。

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use serde_json::Value;

use super::program::{hide_console, resolve_program};
use crate::error::{AgentError, Result};

const FETCH_TIMEOUT: &str = "--fetch-timeout=8000";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PackageManager {
    Bun,
    Pnpm,
    Npm,
}

impl PackageManager {
    const ALL: [Self; 3] = [Self::Bun, Self::Pnpm, Self::Npm];

    pub fn program(self) -> &'static str {
        match self {
            Self::Bun => "bun",
            Self::Pnpm => "pnpm",
            Self::Npm => "npm",
        }
    }

    pub fn resolved(self) -> Option<PathBuf> {
        resolve_program(self.program()).ok()
    }

    /// 交具体版本而不是 latest：包管理器自己再解析可能落到旧版，退出码 0 版本却没到位。
    pub fn install_args(self, package: &str, version: Option<&str>) -> Vec<String> {
        let target = match version {
            Some(version) => format!("{package}@{version}"),
            None => format!("{package}@latest"),
        };

        match self {
            Self::Bun | Self::Pnpm => vec!["add".to_owned(), "--global".to_owned(), target],
            Self::Npm => vec![
                "install".to_owned(),
                "--global".to_owned(),
                target,
                "--no-fund".to_owned(),
                "--no-audit".to_owned(),
            ],
        }
    }

    fn view_args(self, package: &str) -> Vec<String> {
        let verb = match self {
            Self::Bun => "info",
            Self::Pnpm | Self::Npm => "view",
        };

        let mut args = vec![
            verb.to_owned(),
            package.to_owned(),
            "version".to_owned(),
            "--json".to_owned(),
        ];

        /* --fetch-timeout 是 npm 的旗标，另外两家的超时在各自的配置里。 */
        if self == Self::Npm {
            args.push(FETCH_TIMEOUT.to_owned());
        }

        args
    }

    fn global_bin(self) -> Option<PathBuf> {
        let program = self.resolved()?;

        let query = match self {
            Self::Bun => vec!["pm".to_owned(), "bin".to_owned(), "-g".to_owned()],
            Self::Pnpm => vec!["bin".to_owned(), "--global".to_owned()],
            /* npm bin -g 在 npm 9 里被删了。prefix 是它现在还答得上的那个问题。 */
            Self::Npm => vec!["prefix".to_owned(), "--global".to_owned()],
        };

        let spoken = spoken_output(&program, &query)?;
        let line = spoken
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())?;

        let root = PathBuf::from(line);

        Some(match self {
            Self::Bun | Self::Pnpm => root,
            /* Unix 上 npm 的可执行文件在 prefix/bin，Windows 上就在 prefix 里。 */
            Self::Npm if cfg!(windows) => root,
            Self::Npm => root.join("bin"),
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallState {
    Unmanaged,
    Missing,
    Outdated,
    Current,
    External,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstallStatus {
    pub state: InstallState,
    pub installed_version: Option<String>,
    pub latest_version: Option<String>,
    pub package_name: Option<String>,
}

impl InstallStatus {
    #[must_use]
    pub fn plain(state: InstallState) -> Self {
        Self {
            state,
            installed_version: None,
            latest_version: None,
            package_name: None,
        }
    }
}

#[must_use]
pub fn install_state_of(installed: Option<&str>, latest: Option<&str>) -> InstallState {
    match (installed, latest) {
        (None, _) | (Some(_), None) => InstallState::Unknown,
        (Some(current), Some(newest)) => {
            match (
                semver::Version::parse(current),
                semver::Version::parse(newest),
            ) {
                (Ok(current), Ok(newest)) if newest > current => InstallState::Outdated,
                (Ok(_), Ok(_)) => InstallState::Current,
                _ => InstallState::Unknown,
            }
        }
    }
}

/// canonicalize 的是所在目录不是文件：pnpm 全局 bin 里放的是指向内容寻址仓库的符号链接。
#[must_use]
pub fn owner_of(executable: &Path) -> Option<PackageManager> {
    let home = executable.parent()?.canonicalize().ok()?;

    global_bins()
        .iter()
        .find(|(_manager, dir)| {
            dir.canonicalize()
                .is_ok_and(|dir| home == dir || home.starts_with(&dir))
        })
        .map(|(manager, _dir)| *manager)
}

#[must_use]
pub fn preferred_manager() -> Option<PackageManager> {
    PackageManager::ALL
        .iter()
        .copied()
        .find(|manager| manager.resolved().is_some())
}

fn global_bins() -> &'static [(PackageManager, PathBuf)] {
    static BINS: OnceLock<Vec<(PackageManager, PathBuf)>> = OnceLock::new();

    BINS.get_or_init(|| {
        PackageManager::ALL
            .iter()
            .filter_map(|manager| manager.global_bin().map(|dir| (*manager, dir)))
            .collect()
    })
}

fn spoken_output(program: &Path, args: &[String]) -> Option<String> {
    let mut command = Command::new(program);
    command.args(args);
    hide_console(&mut command);

    let output = command.output().ok()?;
    let mut spoken = String::from_utf8_lossy(&output.stdout).into_owned();
    spoken.push('\n');
    spoken.push_str(&String::from_utf8_lossy(&output.stderr));

    Some(spoken)
}

#[must_use]
pub fn first_semver(text: &str) -> Option<String> {
    text.split(|glyph: char| glyph.is_whitespace() || "(),".contains(glyph))
        .map(|token| token.trim_start_matches('v'))
        .find(|token| semver::Version::parse(token).is_ok())
        .map(str::to_owned)
}

pub fn latest_version(manager: PackageManager, package: &str) -> Result<String> {
    let program = manager
        .resolved()
        .ok_or_else(|| toolchain(format!("这台电脑上没有找到 {}", manager.program())))?;

    let spoken = spoken_output(&program, &manager.view_args(package))
        .ok_or_else(|| toolchain(format!("{} 没有执行成功", manager.program())))?;

    /* --json 给的是字符串或多版本数组；两家都可能先打一行提示，读不成 JSON 就扫 semver。 */
    let parsed: Option<Value> = serde_json::from_str(spoken.trim()).ok();

    let version = match parsed {
        Some(Value::String(one)) => Some(one),
        Some(Value::Array(many)) => many.last().and_then(Value::as_str).map(str::to_owned),
        _ => first_semver(&spoken),
    };

    version.ok_or_else(|| toolchain(format!("{package} 的最新版本问不出来")))
}

#[must_use]
pub fn reported_version(program: &Path, version_args: &[String]) -> Option<String> {
    spoken_output(program, version_args)
        .as_deref()
        .and_then(first_semver)
}

pub fn install_package(manager: PackageManager, package: &str, target: Option<&str>) -> Result<()> {
    let program = manager
        .resolved()
        .ok_or_else(|| toolchain(format!("这台电脑上没有找到 {}", manager.program())))?;

    let mut command = Command::new(&program);
    command.args(manager.install_args(package, target));
    hide_console(&mut command);

    let output = command
        .output()
        .map_err(|error| toolchain(format!("{} 没有执行成功：{error}", manager.program())))?;

    if !output.status.success() {
        let spoken = String::from_utf8_lossy(&output.stderr);
        let reason = spoken
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .unwrap_or("包管理器没有说明原因");

        return Err(toolchain(format!("安装没有完成：{reason}")));
    }

    Ok(())
}

fn toolchain(message: String) -> AgentError {
    AgentError::Toolchain { message }
}

#[cfg(test)]
mod tests {
    use super::{PackageManager, first_semver, install_state_of};

    #[test]
    fn a_version_line_is_read_regardless_of_its_layout() {
        assert_eq!(first_semver("omp 18.2.11").as_deref(), Some("18.2.11"));
        assert_eq!(first_semver("v2.0.0-rc.1\n").as_deref(), Some("2.0.0-rc.1"));
    }

    #[test]
    fn a_line_without_a_version_is_not_guessed() {
        assert_eq!(first_semver("command not found"), None);
    }

    #[test]
    fn each_manager_installs_globally_with_its_own_verb() {
        assert_eq!(
            PackageManager::Pnpm.install_args("pkg", Some("1.2.3")),
            vec!["add", "--global", "pkg@1.2.3"]
        );
        assert!(
            PackageManager::Npm
                .install_args("pkg", None)
                .contains(&"pkg@latest".to_owned())
        );
    }

    #[test]
    fn each_manager_asks_the_registry_in_its_own_words() {
        assert!(
            PackageManager::Bun
                .view_args("pkg")
                .contains(&"info".to_owned())
        );
        assert!(
            PackageManager::Pnpm
                .view_args("pkg")
                .contains(&"view".to_owned())
        );
    }

    #[test]
    fn the_state_is_decided_by_semver_not_by_layout() {
        use super::InstallState;

        assert_eq!(install_state_of(None, Some("1.0.0")), InstallState::Unknown);
        assert_eq!(
            install_state_of(Some("18.2.11"), None),
            InstallState::Unknown
        );
        assert_eq!(
            install_state_of(Some("18.2.11"), Some("18.2.11")),
            InstallState::Current
        );
        assert_eq!(
            install_state_of(Some("1.5.0"), Some("18.2.11")),
            InstallState::Outdated
        );
        assert_eq!(
            install_state_of(Some("读不懂"), Some("18.2.11")),
            InstallState::Unknown
        );
    }
}
