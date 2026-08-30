//! 把档案里写的程序名解析成一条真的能启动的路径。

use std::path::{Path, PathBuf};
use std::process::Command;

/// 在这台机器上找不到这个程序。
#[derive(Debug)]
pub struct ProgramNotFound {
    /// 人要读的那句话：说清缺的是什么、装完之后该做什么。
    pub message: String,
    /// 解析器的原始错误，诊断需要它。
    pub source: which::Error,
}

impl std::fmt::Display for ProgramNotFound {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ProgramNotFound {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.source)
    }
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Applies the desktop process policy to every child command.
///
/// GUI 宿主 spawn 控制台程序时，Windows 会给它开一个控制台窗口：选一次工作区
/// 闪一排黑框。全仓唯一的一份；此前 kap-client 与 git-adapter 各持一份。
pub fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

/// 在这台机器上找出该启动哪个文件。
///
/// 一个裸名字不是一条可启动的路径。Windows 上 agent 通常是包管理器装出来的
/// `kimi.CMD`：`CreateProcess` 只会替你补 `.exe`，**不读 PATHEXT**，于是
/// `Command::new("kimi")` 直接 `NotFound` —— 明明装了，却报找不到。
///
/// 所以这里不写死任何路径，也不自己遍历 PATH × PATHEXT。那是 which 这个
/// crate 的既有职责，Zed 解析外部 agent 的可执行文件用的也是它。解析发生在
/// 运行的那台机器上，换机器、换包管理器都不需要改配置；档案里直接写绝对路径
/// 同样成立，which 会原样交还它。
///
/// # Errors
///
/// 在这台机器的搜索路径上找不到这个程序时返回 [`ProgramNotFound`]；它的
/// message 是给人看的（会走到设置页那张卡片上），source 是给日志看的。
pub fn resolve_program(program: &str) -> Result<PathBuf, ProgramNotFound> {
    which::which(program).map_err(|error| ProgramNotFound {
        message: format!(
            "这台电脑上没有找到 {program}。它是一个需要单独安装的命令行程序，\
             装好之后重新打开 Poietica 就能用了。（{error}）"
        ),
        source: error,
    })
}

/// 一条可以直接交给子进程启动器的启动式。
#[derive(Debug, PartialEq, Eq)]
pub struct Launcher {
    pub program: String,
    pub prefix_args: Vec<String>,
}

impl Launcher {
    /// Windows 的 .cmd/.bat 是包管理器写的批处理垫片，`CreateProcess` 与 Node 的
    /// spawn 都拒直接起它们；cmd.exe /c 代起是 VS Code 与 Claude Desktop 的官方
    /// Windows 文档给 stdio MCP 服务器开的同一张方子。
    #[cfg(windows)]
    pub(crate) fn wrap(path: &Path) -> Self {
        let shim = matches!(
            path.extension().and_then(|it| it.to_str()),
            Some(ext) if ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat")
        );

        if shim {
            return Self {
                program: "cmd".to_owned(),
                prefix_args: vec!["/c".to_owned(), path.to_string_lossy().into_owned()],
            };
        }

        Self::plain(path)
    }

    #[cfg(not(windows))]
    pub(crate) fn wrap(path: &Path) -> Self {
        Self::plain(path)
    }

    fn plain(path: &Path) -> Self {
        Self {
            program: path.to_string_lossy().into_owned(),
            prefix_args: Vec::new(),
        }
    }
}

/// 把一个裸名字解析成 mcp.json 的 stdio 条目能直接用的启动式；解不出就是 `None`。
///
/// 写盘那一刻就把这台机器的平台事实固化下来，而不是把裸名留给下游进程碰运气 ——
/// 上面 [`resolve_program`] 那条「CreateProcess 不读 PATHEXT」对起 MCP 子进程的
/// 那一跳同样成立。缺程序不是这次调用的故障，是那台机器的现状，所以是 `None` 不是
/// 错误。与 [`resolve_program`] 共用 which 这一个产地，两条路不许各查一遍。
pub fn resolve_launcher(program: &str) -> Option<Launcher> {
    which::which(program).ok().map(|path| Launcher::wrap(&path))
}

#[cfg(test)]
mod tests {
    use super::{Launcher, resolve_launcher, resolve_program};
    use std::path::Path;

    #[test]
    fn a_name_on_no_search_path_is_reported_rather_than_guessed() {
        assert!(resolve_program("poietica-no-such-program-4f1a").is_err());
    }

    #[test]
    fn an_existing_absolute_path_is_accepted_as_is() {
        // 当前测试二进制本身就是一条已存在的绝对路径，不需要造文件。
        if let Ok(here) = std::env::current_exe() {
            assert!(resolve_program(&here.to_string_lossy()).is_ok());
        }
    }

    #[test]
    fn an_unknown_program_resolves_to_nothing() {
        assert!(resolve_launcher("poietica-no-such-program-4f1a").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn a_batch_shim_is_wrapped_in_cmd_exe() {
        assert_eq!(
            Launcher::wrap(Path::new(r"C:\Users\u\AppData\Roaming\npm\npx.CMD")),
            Launcher {
                program: "cmd".to_owned(),
                prefix_args: vec![
                    "/c".to_owned(),
                    r"C:\Users\u\AppData\Roaming\npm\npx.CMD".to_owned()
                ],
            }
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_plain_executable_is_passed_through() {
        assert_eq!(
            Launcher::wrap(Path::new(r"C:\Tools\server.exe")),
            Launcher {
                program: r"C:\Tools\server.exe".to_owned(),
                prefix_args: Vec::new()
            }
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn a_path_is_passed_through_as_is() {
        assert_eq!(
            Launcher::wrap(Path::new("/usr/bin/node")),
            Launcher {
                program: "/usr/bin/node".to_owned(),
                prefix_args: Vec::new()
            }
        );
    }
}
