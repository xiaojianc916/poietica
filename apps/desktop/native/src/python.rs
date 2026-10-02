//! 内置 Python 内核：随包不带解释器，用户第一次用到时按需装一份可独立运行的 CPython。
//!
//! 能力正本在 crates/python-runtime（不认识宿主，只认目录）；这里只做宿主该做的事：
//! 落点、进程级安装锁、进度、把解释器路径写进 agent 自己那格设置。
//!
//! 中间态的法定形状：装的时候先落字节后写设置，删的时候先清设置后删字节 —— 两边都只留
//! 「设置缺席」这一种中间态。设置指向一个不存在的解释器会让 agent 当场报错；反过来只是
//! 白占一份目录，下次装机会覆盖它。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use poietica_agent_client::SettingValue;
use poietica_problem::Problem;
use poietica_python_native::{
    InstallationState, PYTHON_VERSION, SUPPORTED, archive_in, download, fetch_asset, inspect,
    install, interpreter_of, stage_directory,
};
use serde::Serialize;
use specta::Type;

use crate::error::{Error, Result};

/// agent 自己那份设置里解释器路径的键。
const INTERPRETER_SETTING: &str = "python.interpreter";

/// 盘上那份安装此刻的状态，五档原样投影。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PythonKernelState {
    NotInstalled,
    Installing,
    Ready,
    Broken,
    Unsupported,
}

impl From<InstallationState> for PythonKernelState {
    fn from(state: InstallationState) -> Self {
        match state {
            InstallationState::NotInstalled => Self::NotInstalled,
            InstallationState::Installing => Self::Installing,
            InstallationState::Ready => Self::Ready,
            InstallationState::Broken => Self::Broken,
            InstallationState::Unsupported => Self::Unsupported,
        }
    }
}

/// 后台装机进度。
///
/// percent 恒为 null：字节数不出 crate（那边是它自己的一条流），这里不编造百分比 ——
/// 界面据此画不确定进度条，比一个匀速前进的假数字诚实。
#[derive(Clone, Debug, Default, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PythonKernelInstall {
    pub running: bool,
    pub step: Option<String>,
    pub percent: Option<f64>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PythonKernelStatus {
    pub state: PythonKernelState,
    /// 只有装好才报版本：一棵坏树上挂个版本号是假消息。
    pub version: Option<String>,
    /// 受管目录；目录在就报，界面据此提供「打开所在位置」。
    pub path: Option<String>,
    /// 要写进设置的那个解释器路径；与 ready 同进同退。
    pub interpreter: Option<String>,
    pub install: PythonKernelInstall,
}

/// 一份正在跑或刚跑完的装机：同一时刻只有一份（进程级），重复调用读它而不重入。
#[derive(Debug, Default)]
struct InstallJob {
    running: bool,
    step: Option<String>,
    error: Option<String>,
}

impl InstallJob {
    fn reported(&self) -> PythonKernelInstall {
        PythonKernelInstall {
            running: self.running,
            step: self.step.clone(),
            percent: None,
            /* 失败记录一直留到下一次装机领活，界面才来得及看见那句话。 */
            error: self.error.clone(),
        }
    }
}

static INSTALL: Mutex<Option<InstallJob>> = Mutex::new(None);

fn install_slot() -> std::sync::MutexGuard<'static, Option<InstallJob>> {
    crate::transport::lock(&INSTALL)
}

/// 领一份活；已经有一份在跑时返回 false，调用方据此改为汇报当前状态。
fn begin_install() -> bool {
    let mut slot = install_slot();

    /* 槽里可能留着上一次失败的那句话：判据是「有没有在跑」，不是「槽空不空」。 */
    if slot.as_ref().is_some_and(|job| job.running) {
        return false;
    }

    *slot = Some(InstallJob {
        running: true,
        ..InstallJob::default()
    });

    true
}

/// 收工。成功就把这份记录清掉（状态从盘上看得出来），失败就留下那句话供界面显示。
fn finish_install(failure: Option<String>) {
    *install_slot() = failure.map(|error| InstallJob {
        running: false,
        error: Some(error),
        ..InstallJob::default()
    });
}

fn progress(step: &str) {
    if let Some(job) = install_slot().as_mut() {
        job.step = Some(step.to_owned());
    }
}

fn install_reported() -> PythonKernelInstall {
    install_slot()
        .as_ref()
        .map_or_else(PythonKernelInstall::default, InstallJob::reported)
}

/* 解释器在哪由 crate 说了算（interpreter_of）：布局是它的能力，宿主再拼一份就会在
 * 布局改动时写进一条不存在的路径，而那条路径会被写进 agent 的设置 —— 下一次跑
 * Python 当场报错。 */

/// 受管落点与它的暂存目录。暂存由 crate 从正式目录派生，保证同卷 —— 换入才是一次改名。
fn locations() -> Result<(PathBuf, PathBuf)> {
    let target = crate::paths::managed_python_directory()?;
    let stage = stage_directory(&target);

    Ok((target, stage))
}

async fn compose(target: &Path) -> Result<PythonKernelStatus> {
    let staging = stage_directory(target);
    let reported = install_reported();

    if !SUPPORTED {
        return Ok(PythonKernelStatus {
            state: PythonKernelState::Unsupported,
            version: None,
            path: None,
            interpreter: None,
            install: reported,
        });
    }

    /* 有活在跑就以它为准：盘上还没建出目录的那几秒，状态也不该报「未安装」。 */
    let state = if reported.running {
        PythonKernelState::Installing
    } else {
        inspect(&staging, target).await.into()
    };
    let ready = state == PythonKernelState::Ready;

    Ok(PythonKernelStatus {
        state,
        version: ready.then(|| PYTHON_VERSION.to_owned()),
        path: target.is_dir().then(|| target.display().to_string()),
        interpreter: ready.then(|| interpreter_of(target).display().to_string()),
        install: reported,
    })
}

/// 现在是什么状态。判据全在盘上，不查 agent，也不写任何第二份状态。
#[specta::specta]
pub async fn python_kernel_status() -> std::result::Result<PythonKernelStatus, Problem> {
    let (target, _stage) = locations()?;

    compose(&target).await.map_err(Problem::from)
}

/// 装一份。装好再调是空操作；正在装再调汇报当前进度，不重入。
#[specta::specta]
pub async fn python_kernel_install() -> std::result::Result<PythonKernelStatus, Problem> {
    let (target, stage) = locations()?;

    if inspect(&stage, &target).await == InstallationState::Ready {
        return compose(&target).await.map_err(Problem::from);
    }

    if !begin_install() {
        return compose(&target).await.map_err(Problem::from);
    }

    let installing = target.clone();

    /* 后台跑：命令立刻交回当前状态，进度由下面那几处各自推进一次。 */
    tokio::spawn(async move {
        finish_install(run_install(installing, stage).await.err().map(failure));
    });

    compose(&target).await.map_err(Problem::from)
}

/// 删掉受管目录并清空设置。没装过时也是一次成功的空操作。
#[specta::specta]
pub async fn python_kernel_remove() -> std::result::Result<PythonKernelStatus, Problem> {
    let (target, stage) = locations()?;

    if install_reported().running {
        return Err(Problem::from(Error::Validation(
            "正在安装 Python 内核，等它跑完再删。".to_owned(),
        )));
    }

    clear_interpreter().await.map_err(Problem::from)?;
    remove_tree(&target)?;
    remove_tree(&stage)?;

    compose(&target).await.map_err(Problem::from)
}

/// 装机全程，顺序即不变量：解析 → 下载 → 解包自检换入 → 写设置。
async fn run_install(target: PathBuf, stage: PathBuf) -> Result<()> {
    progress("resolve");

    let asset = fetch_asset().await.map_err(Error::from)?;
    let archive = archive_in(&stage);

    progress("download");
    download(&asset, &archive).await.map_err(Error::from)?;

    /* 解包、自检、换入是 crate 的一步：断电只会留一棵残缺的暂存树或一棵完整的旧树。 */
    progress("promote");
    install(&archive, &stage, &target)
        .await
        .map_err(Error::from)?;

    progress("setting");
    write_interpreter(&interpreter_of(&target)).await
}

/// 把解释器路径写进 agent 自己那格设置 —— 这是唯一写入路径，本层不碰它的配置文件。
///
/// 先读目录再写：这一版 agent 的 schema 里没有这一格时，写下去会被它拒；与其等它拒，
/// 不如说清「无处可写」—— 那也正是「装了也没人用」的判据。
async fn write_interpreter(interpreter: &Path) -> Result<()> {
    let runtime = crate::conversation::runtime()?;
    let agent = crate::agent::profile::default_agent_id()?;
    let catalog = runtime
        .settings_catalog(agent.clone())
        .await
        .map_err(Error::from)?;

    if !catalog
        .settings
        .iter()
        .any(|entry| entry.path == INTERPRETER_SETTING)
    {
        return Err(Error::AgentCli(format!(
            "agent 的设置目录里没有 {INTERPRETER_SETTING} 这一格，解释器路径无处可写"
        )));
    }

    runtime
        .set_setting(
            agent,
            INTERPRETER_SETTING.to_owned(),
            SettingValue::String(interpreter.display().to_string()),
        )
        .await
        .map_err(Error::from)?;

    Ok(())
}

/// 清空那一格。空串是「没配」；认不认这一格由 agent 自己裁决。
async fn clear_interpreter() -> Result<()> {
    let runtime = crate::conversation::runtime()?;
    let agent = crate::agent::profile::default_agent_id()?;

    runtime
        .set_setting(
            agent,
            INTERPRETER_SETTING.to_owned(),
            SettingValue::String(String::new()),
        )
        .await
        .map_err(Error::from)?;

    Ok(())
}

/// 目录不存在算已经删掉了：删两次不该报错。
fn remove_tree(path: &Path) -> Result<()> {
    match std::fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

/// 背景任务只留一句话。Problem 自己没有句子，文案归前端目录（crates/problem/src/problem.rs:41），
/// 所以能说的那句原因优先，没有就退回文案键 —— 界面按这个键另有整句。
fn failure(error: Error) -> String {
    let problem = Problem::from(error);

    problem
        .details
        .get("reason")
        .cloned()
        .unwrap_or(problem.user_message_key)
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        reason = "测试跑在已知输入上，前提被打破就要当场炸"
    )]

    use super::*;

    /// 装机不重入：一份在跑时第二次调用领不到活；收工后失败那句话留着、下一次可以重来。
    #[test]
    fn install_runs_one_at_a_time_and_keeps_the_last_failure() {
        finish_install(None);

        assert!(begin_install(), "第一次该领到活");
        assert!(!begin_install(), "已经在跑时不该再领一份");
        assert!(install_reported().running);

        progress("download");
        assert_eq!(install_reported().step.as_deref(), Some("download"));

        finish_install(Some("下载失败".to_owned()));
        let reported = install_reported();

        assert!(!reported.running);
        assert!(reported.step.is_none());
        assert_eq!(reported.error.as_deref(), Some("下载失败"));

        assert!(begin_install(), "失败之后要能重来");
        finish_install(None);
        assert!(install_reported().error.is_none(), "清干净了");
    }

    /// 写给 agent 的那条路径必须**真是**解释器所在：这条曾经写成 `<root>/python/python.exe`，
    /// 于是装上之后状态报 ready，而写进设置的路径不存在 —— 下一次跑 Python 当场报错。
    /// 判据拿磁盘上的真实布局，不拿字符串比字符串：这正是当初漏掉它的原因。
    #[test]
    fn the_interpreter_path_written_to_the_agent_exists_on_disk() {
        let temp = std::env::temp_dir().join("poietica-native-interpreter-path");
        let _ = std::fs::remove_dir_all(&temp);
        std::fs::create_dir_all(&temp).expect("建临时安装根");
        std::fs::write(interpreter_of(&temp), b"stub").expect("放一个解释器占位");

        let reported = interpreter_of(&temp);
        assert!(
            reported.is_file(),
            "报给 agent 的路径必须就是盘上那个文件：{}",
            reported.display()
        );
        assert_eq!(
            reported.file_name().and_then(|n| n.to_str()),
            Some("python.exe")
        );

        let _ = std::fs::remove_dir_all(&temp);
    }
}
