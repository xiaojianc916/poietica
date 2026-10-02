//! 把下载好的归档落成一份能跑的安装：解包 → 跑通 → 换入。
//!
//! 顺序即不变量：字节只落在暂存目录里，正式目录要么是完整的旧树、要么是完整的新树。
//! 中途断电只会留一棵残缺的暂存树（状态报 installing）或一棵完整的旧树（状态报 ready），
//! 不会出现"装了一半的正式目录"。

use std::path::{Path, PathBuf};

use crate::{EXTRACTED_PYTHON, PythonError, SUPPORTED, replaced_of, verify_installation};

/// 解包用的 bsdtar：Windows 10 起系统自带（C:\Windows\System32\tar.exe），
/// 与其为此拉一个解包库进来，不如用系统那一份。
const TAR: &str = "tar.exe";
/// 22MB 的归档在慢盘上也要解得完，但不许无限挂着。
const EXTRACT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);
/// 暂存目录：正式目录同级（同一个卷，换入才是一次 rename），名字固定。
pub(crate) const STAGING: &str = ".staging";
/// 归档落在暂存目录里的固定文件名。
const ARCHIVE_FILE: &str = "python.tar.gz";

/// 暂存目录的落点：宿主只管传正式目录，暂存由这里派生，免得两处各写一个名字。
#[must_use]
pub fn stage_directory(target: &Path) -> PathBuf {
    let mut name = target.as_os_str().to_os_string();
    name.push(STAGING);

    PathBuf::from(name)
}

/// 归档在暂存目录里的落点；宿主先 `download` 到这里，再交给 `install`。
#[must_use]
pub fn archive_in(stage: &Path) -> PathBuf {
    stage.join(ARCHIVE_FILE)
}

/// 装一份到 `target`，返回装好的那棵树的根。
///
/// 落点由宿主传入：crate 不认识 paths.rs，也不知道暂存与正式目录之间是什么关系，
/// 只要求两者不同 —— 暂存还得跟正式目录同一个卷，换入才是一次 rename。
pub async fn install(archive: &Path, stage: &Path, target: &Path) -> Result<PathBuf, PythonError> {
    if !SUPPORTED {
        return Err(PythonError::Unsupported);
    }

    if stage == target {
        return Err(PythonError::SameDirectory(target.to_path_buf()));
    }

    let extracted = extract(archive, stage).await?;
    verify_installation(&extracted).await?;
    promote_into_place(&extracted, target)?;
    let _ = std::fs::remove_dir_all(stage);

    Ok(target.to_path_buf())
}

/// 解包到暂存目录并返回解出来的那棵树 —— **它就是解释器家目录**
/// （`<stage>/python/` 里直接是 python.exe 与 Lib/、DLLs/），换入时整棵搬走，不再剥壳。
///
/// 只清解出来的那棵子树，不整删暂存目录：归档就落在暂存目录里（见 `archive_in`），
/// 整删会把刚下的 22MB 连同本次解包一起删掉。
pub async fn extract(archive: &Path, stage: &Path) -> Result<PathBuf, PythonError> {
    let extracted = stage.join(EXTRACTED_PYTHON);

    if extracted.exists() {
        tokio::fs::remove_dir_all(&extracted).await?;
    }

    tokio::fs::create_dir_all(stage).await?;

    let mut command = crate::quiet(Path::new(TAR));
    command
        .arg("-xzf")
        .arg(archive)
        .arg("-C")
        .arg(stage)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    let output = crate::output_with_timeout(command, EXTRACT_TIMEOUT)
        .await
        .ok_or_else(|| PythonError::Extract {
            archive: label(archive),
            message: format!("tar 超过 {}s 没有结束", EXTRACT_TIMEOUT.as_secs()),
        })?;

    if !output.status.success() {
        return Err(PythonError::Extract {
            archive: label(archive),
            message: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        });
    }

    Ok(extracted)
}

/// 换入正式目录。目标已存在时不能一次 rename（Windows 不能 rename 到已存在的目录），
/// 旧树先改名让位、新树 rename 入、最后删旧树；中间任何一步断电都还留着一棵完整的树。
pub fn promote_into_place(payload: &Path, target: &Path) -> Result<(), PythonError> {
    if !payload.is_dir() {
        return Err(PythonError::PayloadMissing(payload.to_path_buf()));
    }

    let failed = |message: String| PythonError::Promote {
        target: target.to_path_buf(),
        message,
    };

    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let replaced = replaced_of(target);

    if replaced.exists() {
        std::fs::remove_dir_all(&replaced)?;
    }

    let retired = if target.exists() {
        std::fs::rename(target, &replaced)?;
        true
    } else {
        false
    };

    if let Err(error) = std::fs::rename(payload, target) {
        // 新树没进去就把旧树换回来：宁可是旧的那一份，也不能两边都没有。
        if retired {
            let _ = std::fs::rename(&replaced, target);
        }

        return Err(failed(error.to_string()));
    }

    if retired {
        std::fs::remove_dir_all(&replaced)?;
    }

    Ok(())
}

/// 归档名只用来在对账时报出是哪一个文件。
fn label(archive: &Path) -> String {
    archive.file_name().map_or_else(
        || archive.display().to_string(),
        |name| name.to_string_lossy().into_owned(),
    )
}
