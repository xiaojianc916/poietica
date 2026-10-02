//! 随包不带解释器，用户第一次用到 Python 能力时按需装一份可独立运行的 CPython；
//! 状态一律从盘上那份安装推导，不存第二份。宿主只传落点（见 `install` 的注释），
//! crate 自己不认 paths.rs。

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use thiserror::Error;

mod install;
mod release;
#[cfg(test)]
mod tests;

pub use install::{archive_in, extract, install, promote_into_place, stage_directory};
#[doc(inline)]
pub use interpreter_of as interpreter;
pub use release::{
    ARCHIVE, Asset, PLATFORM, PYTHON_VERSION, RELEASE_TAG, ReleaseError, asset_name, download,
    fetch_asset, parse_sha256, select_asset,
};

/// 装机只在 Windows 上做：上游那套资产名与解包后命中的相对路径都随平台变，
/// 本仓桌面端也只发 Windows，多写一套是为没人跑的路径养第二份真话。
pub const SUPPORTED: bool = cfg!(windows);

/// 盘上那份安装的尺寸、摘要与来源。字段全部来自上游 release 接口，本仓不维护副本。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstallationFacts {
    pub version: String,
    pub size: u64,
    /// 上游给的摘要全串，形如 sha256:…。
    pub digest: String,
}

impl InstallationFacts {
    #[must_use]
    pub fn from_asset(asset: &Asset) -> Self {
        Self {
            version: PYTHON_VERSION.to_owned(),
            size: asset.size,
            digest: asset.digest.clone(),
        }
    }
}

/// 状态五档。判定要跑一次解释器才敢说 ready：解包成功不等于装好。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InstallationState {
    NotInstalled,
    Installing,
    Ready,
    Broken,
    Unsupported,
}

/// 领域错误：装机这条线上每一种失败都能被宿主分别处置（可重试 / 要用户介入 / 本机不支持）。
#[derive(Debug, Error)]
pub enum PythonError {
    #[error("本机不支持内置 Python（仅 Windows）")]
    Unsupported,
    #[error("python-build-standalone 的 release {tag} 里没有资产 {asset}")]
    AssetMissing { tag: String, asset: String },
    #[error(
        "python-build-standalone 的 release {tag} 里资产 {asset} 命中 {count} 条，只认恰好一条"
    )]
    AssetAmbiguous {
        tag: String,
        asset: String,
        count: usize,
    },
    #[error(transparent)]
    Release(#[from] ReleaseError),
    #[error("下载 {asset} 失败：{reason}")]
    Download { asset: String, reason: String },
    #[error("{asset} 声明 {expected} 字节，实际 {actual} 字节")]
    SizeMismatch {
        asset: String,
        expected: u64,
        actual: u64,
    },
    #[error("{asset} 的 sha256 是 {actual}，上游声明 {expected}")]
    DigestMismatch {
        asset: String,
        expected: String,
        actual: String,
    },
    #[error("解包 {archive} 失败：{message}")]
    Extract { archive: String, message: String },
    #[error("解包后 {0} 不存在")]
    PayloadMissing(PathBuf),
    #[error("暂存与目标必须是不同的目录：{0}")]
    SameDirectory(PathBuf),
    #[error("{0} 不是一棵能跑的 Python 安装")]
    NotExecutable(PathBuf),
    #[error("换入 {target} 失败：{message}")]
    Promote { target: PathBuf, message: String },
    #[error("文件读写失败：{0}")]
    Io(#[from] std::io::Error),
}

/// 上游 install_only 归档的顶层目录名 —— 解包到暂存目录时命中它。
///
/// 它只出现在**暂存**一侧。受管目录（target）的布局是解释器家目录：
/// 解释器就在根上（`<target>/python.exe`），库里没有第二层同名目录。
/// 上游那个顶层 `python/` 只是它的打包外壳，换入时剥掉。
pub(crate) const EXTRACTED_PYTHON: &str = "python";
pub(crate) const EXECUTABLE: &str = "python.exe";
/// 旧树让位时退到同级的这个名字下（名字由 replaced_of 拼出来）。
pub(crate) const REPLACED: &str = ".replaced";

/// 旧树退到 target 同级而不是 target 内部：目录不能 rename 进自己。
pub(crate) fn replaced_of(target: &Path) -> PathBuf {
    let mut name = target.as_os_str().to_os_string();
    name.push(REPLACED);

    PathBuf::from(name)
}

/// 判定一份安装现在是什么状态：判据只有盘上有什么、以及里面的解释器跑不跑得起来。
pub async fn inspect(stage: &Path, target: &Path) -> InstallationState {
    if !SUPPORTED {
        return InstallationState::Unsupported;
    }

    if target.is_dir() {
        let Some(executable) = executable_of(target) else {
            return InstallationState::Broken;
        };

        return if runs(&executable).await {
            InstallationState::Ready
        } else {
            InstallationState::Broken
        };
    }

    if stage.is_dir() {
        return InstallationState::Installing;
    }

    InstallationState::NotInstalled
}

/// 一份安装里解释器在哪：`<root>/python.exe`。
///
/// 宿主写 `python.interpreter` 时要用它 —— 别在宿主侧再拼一次：布局归这一份常量的产地管，
/// 拼第二份就会在布局改动时悄悄写进一条不存在的路径。
#[must_use]
pub fn interpreter_of(root: &Path) -> PathBuf {
    root.join(EXECUTABLE)
}

/// 装机只认盘上这份可执行文件；它就在安装树的根上（见 `EXTRACTED_PYTHON`）。
pub(crate) fn executable_of(root: &Path) -> Option<PathBuf> {
    let executable = interpreter_of(root);

    executable.is_file().then_some(executable)
}

/// 解包出来的树是一个能用的解释器吗：跑一次才算，返回的错误带上是哪条路径不行。
pub async fn verify_installation(root: &Path) -> Result<(), PythonError> {
    if !SUPPORTED {
        return Err(PythonError::Unsupported);
    }

    let missing = || interpreter_of(root);
    let executable = executable_of(root).ok_or_else(|| PythonError::PayloadMissing(missing()))?;

    if runs(&executable).await {
        return Ok(());
    }

    Err(PythonError::NotExecutable(executable))
}

/// 解释器自检：`-I` 已经隔离掉用户环境与 site，能 import sys 就算那份安装是完整的。
async fn runs(executable: &Path) -> bool {
    let mut command = quiet(executable);
    command
        .args(["-I", "-c", "import sys"])
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    output_with_timeout(command, VERIFY_TIMEOUT)
        .await
        .is_some_and(|output| output.status.success())
}

/// 解释器自检的时间上限：一份装坏的树会卡在导入上，不能把状态查询一起拖住。
const VERIFY_TIMEOUT: Duration = Duration::from_secs(30);

/// GUI 宿主起的控制台进程会闪黑框。crates/process-host/src/program.rs 那份绑的是标准库的
/// Command，这里这份绑 tokio 的，所以本 crate 也留一份常量。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 起一条不弹窗口、不占输入、且 future 被丢掉时会被杀掉的子进程。
pub(crate) fn quiet(program: &Path) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(program);
    command.stdin(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    command
}

/// 跑一条命令并设死线，两条输出管道一起读干（只 wait 不读，stderr 写满管道就把子进程堵死）。
/// 超时不用 tokio::time::timeout 单包就算了：kill_on_drop 保证被丢掉的 future 不会留下孤儿。
pub(crate) async fn output_with_timeout(
    mut command: tokio::process::Command,
    timeout: Duration,
) -> Option<std::process::Output> {
    tokio::time::timeout(timeout, command.output())
        .await
        .ok()?
        .ok()
}
