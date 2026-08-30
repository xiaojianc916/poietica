//! agent 运行时的安装与更新：包管理器归属、最新版查询、一次安装的执行。
//!
//! ## 用哪个包管理器，不是猜出来的，是查出来的
//!
//! PATH 上的 kimi 只是一个 shim，它归谁管取决于当初是谁放的。用 npm 去升级一份
//! pnpm 装的运行时，不会升级它，只会在 npm 的 prefix 里放第二个同名 shim：两份
//! 同时在 PATH 上，谁生效由 PATH 顺序决定，于是界面说新版本、进程跑旧版本，而且
//! 一声不吭。所以归属从已解析出的那个文件反查 —— 它的目录落在谁的全局 bin 里，
//! 它就归谁。
//!
//! 三家都不是（官方安装脚本、Homebrew、手工放的）就是 External：装了，但不归
//! 我们管。这种情况下一个按钮都不画 —— 替用户装第二份是比不作为更坏的结果。
//!
//! 还没装时才需要挑一个，顺序是 bun、pnpm、npm。npm 随 Node.js 必然存在，把它当
//! 默认等于对每一个刻意装过别家的人都装错地方。
//!
//! ## 最新版问包管理器自己
//!
//! 不是手写的 HTTP 请求：registry、镜像、代理与企业证书全在它的配置里，绕过去
//! 就是在国内镜像下必然检测失败。缓存的存取归宿主（它在 agents.json 里）；这里
//! 只有查询与执行。

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use serde_json::Value;

use super::program::{hide_console, resolve_program};
use crate::error::{KapError, Result};

/// 检测不该把界面挂住。安装没有这道闸：它本来就可能跑几分钟。
const FETCH_TIMEOUT: &str = "--fetch-timeout=8000";

/// 三家受管的包管理器。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PackageManager {
    Bun,
    Pnpm,
    Npm,
}

impl PackageManager {
    /// 顺序即优先级，只在「还没装」时用得上。理由见模块头。
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

    /// 装到一个具体版本，而不是把 latest 这个标签交回去。
    ///
    /// latest 由谁解析是有分歧的：我们这一侧 view 出来是 0.31.1，包管理器自己再解析
    /// 一次可能因为元数据缓存落到 0.31.0 —— 退出码 0，版本却没到位，界面只好把同一个
    /// 按钮再画一次。调用方已解析过最新版，就把那个具体版本号交下来；查不到时才退回
    /// latest，让包管理器自己决定。
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
        /* 动词各家不同：bun 是 info，pnpm 与 npm 是 view。 */
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

    /// 这个包管理器把全局可执行文件放在哪。
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

/// 一个 agent 运行时此刻的安装处境。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallState {
    /// 档案没说这东西怎么装。界面什么都不画。
    Unmanaged,
    Missing,
    Outdated,
    Current,
    /// 装着，但不是 bun、pnpm、npm 装的。我们不碰别人的安装。
    External,
    /// 装着，但问不到最新版（离线、镜像不通），或者它的 --version 读不懂。
    Unknown,
}

/// 安装检测的完整答案。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstallStatus {
    pub state: InstallState,
    pub installed_version: Option<String>,
    pub latest_version: Option<String>,
    pub package_name: Option<String>,
}

impl InstallStatus {
    /// 只有处境、没有版本的答案。
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

/// 装与没装、新与旧的裁决。纯函数：判据是 semver，不是排版。
#[must_use]
pub fn install_state_of(installed: Option<&str>, latest: Option<&str>) -> InstallState {
    match (installed, latest) {
        /* 文件在，只是它的 --version 读不懂。这不是「没装」。 */
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

/// 这个可执行文件是谁装的。
///
/// 规范化的是它所在的目录，不是它本身：pnpm 的全局 bin 里放的是指向内容寻址仓库的
/// 符号链接，把文件本身 canonicalize 掉，就再也认不出它原本挂在谁的 bin 下面。
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

/// 还没装时挑哪一个：bun、pnpm、npm，第一个解析得到的。
#[must_use]
pub fn preferred_manager() -> Option<PackageManager> {
    PackageManager::ALL
        .iter()
        .copied()
        .find(|manager| manager.resolved().is_some())
}

/// 两个包管理器的全局 bin 目录。一次会话查一次 —— 它在进程存续期间不会变。
fn global_bins() -> &'static [(PackageManager, PathBuf)] {
    static BINS: OnceLock<Vec<(PackageManager, PathBuf)>> = OnceLock::new();

    BINS.get_or_init(|| {
        PackageManager::ALL
            .iter()
            .filter_map(|manager| manager.global_bin().map(|dir| (*manager, dir)))
            .collect()
    })
}

/// 跑一个程序，stdout 与 stderr 合在一起交回来。
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

/// 一段输出里第一个说得通的 semver。
///
/// 各家 --version 的排版不一样（"kimi-code 1.4.2"、"v1.4.2"、带 build 后缀），
/// 但版本号本身是标准的，所以判据交给 semver，而不是猜排版。
#[must_use]
pub fn first_semver(text: &str) -> Option<String> {
    text.split(|glyph: char| glyph.is_whitespace() || "(),".contains(glyph))
        .map(|token| token.trim_start_matches('v'))
        .find(|token| semver::Version::parse(token).is_ok())
        .map(str::to_owned)
}

/// 问包管理器这个包的最新版本。
///
/// # Errors
///
/// 包管理器缺席、没有执行成功，或问不出一个版本时返回错误。
pub fn latest_version(manager: PackageManager, package: &str) -> Result<String> {
    let program = manager
        .resolved()
        .ok_or_else(|| toolchain(format!("这台电脑上没有找到 {}", manager.program())))?;

    let spoken = spoken_output(&program, &manager.view_args(package))
        .ok_or_else(|| toolchain(format!("{} 没有执行成功", manager.program())))?;

    /*
     * --json 下给的是一个字符串，多版本匹配时是一个数组。两家的实现都可能在前面先
     * 打一行提示，所以读不成 JSON 时退回「扫出第一个 semver」——判据仍然是 semver，
     * 不是排版。
     */
    let parsed: Option<Value> = serde_json::from_str(spoken.trim()).ok();

    let version = match parsed {
        Some(Value::String(one)) => Some(one),
        Some(Value::Array(many)) => many.last().and_then(Value::as_str).map(str::to_owned),
        _ => first_semver(&spoken),
    };

    version.ok_or_else(|| toolchain(format!("{package} 的最新版本问不出来")))
}

/// 这个程序自己报的版本：跑它、听它说、扫出第一个 semver。
#[must_use]
pub fn reported_version(program: &Path, version_args: &[String]) -> Option<String> {
    spoken_output(program, version_args)
        .as_deref()
        .and_then(first_semver)
}

/// 用这一个包管理器全局安装一个包（可以钉住版本）。
///
/// # Errors
///
/// 包管理器没有执行成功，或它自己说了不时返回错误 —— stderr 的第一句非空行
/// 原样带回来，那是用户唯一拿得去修正的信息。
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

fn toolchain(message: String) -> KapError {
    KapError::Toolchain { message }
}

#[cfg(test)]
mod tests {
    use super::{PackageManager, first_semver, install_state_of};

    #[test]
    fn a_version_line_is_read_regardless_of_its_layout() {
        assert_eq!(first_semver("kimi-code 1.4.2").as_deref(), Some("1.4.2"));
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
        assert_eq!(install_state_of(Some("1.4.2"), None), InstallState::Unknown);
        assert_eq!(
            install_state_of(Some("1.4.2"), Some("1.4.2")),
            InstallState::Current
        );
        assert_eq!(
            install_state_of(Some("1.4.2"), Some("1.5.0")),
            InstallState::Outdated
        );
        assert_eq!(
            install_state_of(Some("读不懂"), Some("1.5.0")),
            InstallState::Unknown
        );
    }
}
