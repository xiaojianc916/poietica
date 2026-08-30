//! 把档案里写的程序名解析成一条真的能启动的路径。

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::error::{KapError, Result};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Applies the desktop process policy to every child command.
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
/// 运行的那台机器上，换机器、换包管理器都不需要改配置；`agents.json` 里直接
/// 写绝对路径同样成立，which 会原样交还它。
///
/// 这个函数是唯一的解析处。kap 会话与 provider CLI 起的是同一个程序，两处
/// 各解析一次，迟早解析出两个结果 —— 上一版就是这么坏的：会话那条会解析，
/// CLI 那条不会。
///
/// 解析失败的那句话是给人看的，不是给日志看的。
///
/// which 的错误是一句英文技术串。它会一路走到设置页那张卡片上
/// （describeAgentCliFailure 直接取 cause.message），也就是说：一个刚装好这个
/// 软件的人，第一次打开设置想看看有哪些模型，得到的是一句英文报错。
///
/// 而这不是异常路径，这是**每一台新电脑上的必经之路**。安装包里没有
/// externalBin 也没有 resources，agent CLI 从来就不在里面 —— 它是用户要自己
/// 装的一个命令行程序。同一份 tauri.conf.json 对 `WebView2` 是认真的
/// （embedBootstrapper + silent），对这个真正的核心依赖一个字都没说。
///
/// 装包这件事这一轮不动。能立刻不撒谎的是这句话：说清缺的是什么、以及装完
/// 之后该做什么。原始错误留在括号里，诊断需要它。
///
/// # Errors
///
/// 在这台机器的搜索路径上找不到这个程序时返回 [`KapError::Spawn`]。
pub fn resolve_program(program: &str) -> Result<PathBuf> {
    which::which(program).map_err(|error| KapError::Spawn {
        message: format!(
            "这台电脑上没有找到 {program}。它是一个需要单独安装的命令行程序，\
             装好之后重新打开 Poietica 就能用了。（{error}）"
        ),
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
    fn wrap(path: &Path) -> Self {
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
    fn wrap(path: &Path) -> Self {
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
/// 上面 [`resolve_program`] 那条「CreateProcess 不读 PATHEXT」对 kap 起 MCP 子进程的
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
