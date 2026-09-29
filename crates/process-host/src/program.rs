//! 把档案里写的程序名解析成一条真的能启动的路径。

use std::path::{Path, PathBuf};
use std::process::Command;
#[derive(Debug)]
pub struct ProgramNotFound {
    pub message: String,
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

/// GUI 宿主 spawn 控制台程序时 Windows 会开控制台窗口；全仓唯一的一份。
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

/// `CreateProcess` 只补 `.exe` 不读 PATHEXT，包管理器装的 `kimi.CMD` 得靠 which 解析。
pub fn resolve_program(program: &str) -> Result<PathBuf, ProgramNotFound> {
    which::which(program).map_err(|error| ProgramNotFound {
        message: format!(
            "这台电脑上没有找到 {program}。它是一个需要单独安装的命令行程序，\
             装好之后重新打开 Poietica 就能用了。（{error}）"
        ),
        source: error,
    })
}

/// 随包发的文件落在应用可执行文件旁边（Tauri 的 bundle.resources 摆在那儿），不在 PATH 上。
///
/// 只认这个名字、不补后缀：同一个目录里既摆着可执行文件（`bun.exe`），也摆着脚本
/// （`poietica-bridge.js`），补后缀会把后者找成不存在的 `*.js.exe`。
pub fn beside_exe(directory: &Path, name: &str) -> Option<PathBuf> {
    let candidate = directory.join(name);

    candidate.is_file().then_some(candidate)
}

/// 随包发的那个伴侣程序：先找随包目录，再回落到 PATH。
///
/// 回落是给开发期留的（手动跑源码版的运行时），它也会掩盖「打包漏了文件」这类
/// 缺口 —— 所以调用方对**必须随包发**的东西要用 [`beside_exe`]，不要走这条。
pub fn resolve_sidecar(directory: &Path, name: &str) -> Result<PathBuf, ProgramNotFound> {
    if let Some(candidate) = beside_exe(
        directory,
        &format!("{name}{}", std::env::consts::EXE_SUFFIX),
    ) {
        return Ok(candidate);
    }

    resolve_program(name)
}

#[derive(Debug, PartialEq, Eq)]
pub struct Launcher {
    pub program: String,
    pub prefix_args: Vec<String>,
}

impl Launcher {
    /// .cmd/.bat 是包管理器写的批处理垫片，`CreateProcess` 与 Node spawn 都拒直接起，cmd /c 代起。
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

pub fn resolve_launcher(program: &str) -> Option<Launcher> {
    which::which(program).ok().map(|path| Launcher::wrap(&path))
}

#[cfg(test)]
mod tests {
    use super::{Launcher, resolve_launcher, resolve_program, resolve_sidecar};
    use std::path::Path;

    #[test]
    fn a_name_on_no_search_path_is_reported_rather_than_guessed() {
        assert!(resolve_program("poietica-no-such-program-4f1a").is_err());
    }

    #[test]
    fn a_sidecar_that_is_nowhere_falls_back_to_the_search_path_and_fails_loudly() {
        assert!(resolve_sidecar(Path::new("."), "poietica-no-such-sidecar-4f1a").is_err());
    }

    #[test]
    fn a_bundled_file_is_found_next_to_the_app_and_not_by_name_alone() {
        let here = std::env::temp_dir();

        /* 缺席就是缺席：不猜路径、不补后缀，`beside_exe` 与 which 无关。 */
        assert!(super::beside_exe(&here, "poietica-no-such-bundled-4f1a.js").is_none());
    }

    #[test]
    fn an_existing_absolute_path_is_accepted_as_is() {
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
