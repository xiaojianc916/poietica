//! 单测不联网、不装解释器：资产选择与摘要解析喂数据，
//! 状态判定与换入规则在临时目录里造真的目录树。

#![allow(
    clippy::expect_used,
    clippy::unwrap_used,
    clippy::panic,
    reason = "测试作用域内的失败就该直接炸出来"
)]

use std::path::{Path, PathBuf};

use tempfile::TempDir;

use crate::release::{Asset, asset_name, mirror_url, select_asset};
use crate::*;

/// 一条候选：只有名字参与选择，其余字段原样带走。
fn asset(name: &str) -> Asset {
    Asset {
        name: name.to_owned(),
        size: 22_013_771,
        digest: format!("sha256:{}", "a".repeat(64)),
        url: "https://api.github.com/example".to_owned(),
    }
}

/// 20261001 那一批里含平台串且以 install_only_stripped.tar.gz 结尾的资产名，
/// 共 9 条（删掉任何一条这份常量就与上游不符）。名字逐字相等才选得中唯一一条。
fn release_assets() -> Vec<Asset> {
    let names = [
        "cpython-3.10.19+20261001-x86_64-pc-windows-msvc-install_only_stripped.tar.gz",
        "cpython-3.11.14+20261001-x86_64-pc-windows-msvc-install_only_stripped.tar.gz",
        "cpython-3.12.15+20261001-x86_64-pc-windows-msvc-install_only_stripped.tar.gz",
        "cpython-3.13.9+20261001-x86_64-pc-windows-msvc-install_only_stripped.tar.gz",
        "cpython-3.13.9+20261001-x86_64-pc-windows-msvc-freethreaded-install_only_stripped.tar.gz",
        "cpython-3.14.2+20261001-x86_64-pc-windows-msvc-install_only_stripped.tar.gz",
        "cpython-3.14.2+20261001-x86_64-pc-windows-msvc-freethreaded-install_only_stripped.tar.gz",
        "cpython-3.15.0rc1+20261001-x86_64-pc-windows-msvc-install_only_stripped.tar.gz",
        "cpython-3.15.0rc1+20261001-x86_64-pc-windows-msvc-freethreaded-install_only_stripped.tar.gz",
    ];

    let mut assets = names.iter().map(|name| asset(name)).collect::<Vec<_>>();
    /* 名单外还有别的平台与别的打包档，子串判据就是被它们带歪的。 */
    assets.push(asset(
        "cpython-3.12.15+20261001-aarch64-pc-windows-msvc-install_only_stripped.tar.gz",
    ));
    assets.push(asset(
        "cpython-3.12.15+20261001-x86_64-pc-windows-msvc-install_only.tar.gz",
    ));

    assets
}

#[test]
fn picks_exactly_one_asset() {
    let assets = release_assets();
    let picked = select_asset(&assets).expect("候选里恰好有一条");

    assert_eq!(picked.name, asset_name());
    assert_eq!(
        assets
            .iter()
            .filter(|candidate| candidate.name == picked.name)
            .count(),
        1
    );
}

#[test]
fn missing_asset_is_typed() {
    let assets = release_assets()
        .into_iter()
        .filter(|candidate| candidate.name != asset_name())
        .collect::<Vec<_>>();

    assert!(matches!(
        select_asset(&assets),
        Err(PythonError::AssetMissing { .. })
    ));
}

#[test]
fn ambiguous_asset_is_typed() {
    let mut assets = release_assets();
    assets.push(asset(&asset_name()));

    assert!(matches!(
        select_asset(&assets),
        Err(PythonError::AssetAmbiguous { count: 2, .. })
    ));
}

/// 镜像地址由 tag 与资产名拼出来，两个常量各只写一遍；它与上游资产名必须逐字对齐，
/// 拼错了就是 404，而 404 会被当成「镜像没有」静默回落到 GitHub —— 那正是本次要修的那条慢路。
#[test]
fn mirror_url_is_the_upstream_asset_name_under_the_tag() {
    assert_eq!(
        mirror_url(),
        format!(
            "https://registry.npmmirror.com/-/binary/python-build-standalone/{RELEASE_TAG}/{}",
            asset_name()
        )
    );
}

#[test]
fn parses_sha256_prefix() {
    let digest = "sha256:52124CEE54126F3F360EAA378288F6F64C402C983A3C14C95EFF67F4AF986AAA";
    let parsed = parse_sha256(digest).expect("前缀与长度都对");

    assert_eq!(parsed, digest.trim_start_matches("sha256:").to_lowercase());
    assert_eq!(parsed.len(), 64);
}

#[test]
fn rejects_malformed_digest() {
    for digest in ["", "sha256:", "md5:52124cee", "sha256:zz"] {
        assert!(
            matches!(
                parse_sha256(digest),
                Err(PythonError::DigestMismatch { .. })
            ),
            "{digest} 不该被当成合法摘要"
        );
    }

    let short = format!("sha256:{}", "a".repeat(63));
    let long = format!("sha256:{}", "a".repeat(65));
    assert!(parse_sha256(&short).is_err());
    assert!(parse_sha256(&long).is_err());
}

#[test]
fn staging_directory_is_not_the_install_directory() {
    let target = Path::new("C:/Users/someone/.poietica/python");
    let stage = stage_directory(target);

    assert_ne!(stage, target);
    assert_eq!(stage.parent(), target.parent());
    assert_ne!(archive_in(&stage), archive_in(target));
    assert!(archive_in(&stage).starts_with(&stage));
}

#[test]
fn derived_names_are_not_siblings_of_each_other() {
    let target = Path::new("C:/home/.poietica/python");

    assert_ne!(stage_directory(target), replaced_of(target));
    assert_eq!(
        replaced_of(target).file_name(),
        Some("python.replaced".as_ref())
    );
}

#[cfg(windows)]
mod windows {
    use super::*;

    /// 一棵只有可执行文件外壳的假安装：文件占位用，解释器跑不起来。
    ///
    /// 解释器写在**根上**：受管目录自己就是解释器家目录（`executable_of` 的判据）。
    fn stub(root: &Path) {
        std::fs::create_dir_all(root).expect("建目录");
        std::fs::write(root.join("python.exe"), b"stub").expect("写占位文件");
    }

    fn target_in(temp: &TempDir) -> PathBuf {
        temp.path().join("python")
    }

    #[tokio::test]
    async fn states_are_read_off_the_disk() {
        let temp = TempDir::new().expect("临时目录");
        let target = target_in(&temp);

        assert_eq!(inspect(&target).await, InstallationState::NotInstalled);

        stub(&target);
        assert_eq!(inspect(&target).await, InstallationState::Broken);

        std::fs::remove_dir_all(&target).expect("删掉假安装");
        assert_eq!(inspect(&target).await, InstallationState::NotInstalled);
    }

    /// 中断留下的暂存目录**不等于**「正在装」：曾经拿它在不在当判据，于是一次断网
    /// 之后界面永远停在「准备中」、连重试按钮都不给。判据只能是解释器在不在。
    #[tokio::test]
    async fn a_leftover_staging_tree_is_not_an_installation_in_progress() {
        let temp = TempDir::new().expect("临时目录");
        let target = target_in(&temp);
        let stage = stage_directory(&target);

        std::fs::create_dir_all(&stage).expect("造上一轮中断留下的暂存树");
        std::fs::write(stage.join("python.tar.gz"), b"half a download").expect("写残档");

        assert_eq!(
            inspect(&target).await,
            InstallationState::NotInstalled,
            "残档不是一份安装，也不该冒充「正在装」"
        );
    }

    #[tokio::test]
    async fn interpreter_that_cannot_run_is_broken() {
        let temp = TempDir::new().expect("临时目录");
        let target = target_in(&temp);
        stub(&target);

        assert!(matches!(
            verify_installation(&target).await,
            Err(PythonError::NotExecutable(_))
        ));
    }

    /// 归档落在暂存目录里，解包只清解出来的那棵子树：把归档一起删掉就等于删掉本次入参。
    #[tokio::test]
    async fn extract_keeps_the_archive_it_is_given() {
        let temp = TempDir::new().expect("临时目录");
        let target = target_in(&temp);
        let stage = stage_directory(&target);
        let archive = archive_in(&stage);
        std::fs::create_dir_all(&stage).expect("造暂存目录");
        std::fs::write(&archive, b"not really a tarball").expect("写归档占位");

        let leftover = stage.join("python").join("leftover.marker");
        std::fs::create_dir_all(stage.join("python")).expect("造上一轮残留");
        std::fs::write(&leftover, b"leftover").expect("写残留");

        assert!(
            extract(&archive, &stage).await.is_err(),
            "这不是一个真的 tar"
        );
        assert!(archive.is_file(), "归档是本次入参，不能被解包删掉");
        assert!(!leftover.exists(), "上一轮解出来的子树要先清掉");
    }

    #[tokio::test]
    async fn verify_reports_a_missing_executable() {
        let temp = TempDir::new().expect("临时目录");

        assert!(matches!(
            verify_installation(temp.path()).await,
            Err(PythonError::PayloadMissing(_))
        ));
    }

    #[tokio::test]
    async fn install_refuses_stage_that_is_the_target() {
        let temp = TempDir::new().expect("临时目录");
        let target = target_in(&temp);

        assert!(matches!(
            install(Path::new("missing.tar.gz"), &target, &target).await,
            Err(PythonError::SameDirectory(_))
        ));
    }

    #[test]
    fn promote_retires_the_tree_that_is_already_there() {
        let temp = TempDir::new().expect("临时目录");
        let target = target_in(&temp);
        stub(&target);
        std::fs::write(target.join("old.marker"), b"old").expect("写旧标记");

        let payload = temp.path().join("payload");
        std::fs::create_dir_all(&payload).expect("造新树");
        std::fs::write(payload.join("python.exe"), b"new").expect("写新文件");

        promote_into_place(&payload, &target).expect("换入成功");

        assert!(target.join("python.exe").is_file());
        assert!(!target.join("old.marker").exists());
        assert!(!replaced_of(&target).exists());
        assert!(!payload.exists());
    }

    #[test]
    fn promote_creates_the_install_directory_when_absent() {
        let temp = TempDir::new().expect("临时目录");
        let target = target_in(&temp);
        let payload = temp.path().join("payload");
        std::fs::create_dir_all(&payload).expect("造新树");

        promote_into_place(&payload, &target).expect("换入成功");

        assert!(target.is_dir());
    }

    #[test]
    fn promote_refuses_a_payload_that_is_not_there() {
        let temp = TempDir::new().expect("临时目录");
        let target = target_in(&temp);

        assert!(matches!(
            promote_into_place(&temp.path().join("nope"), &target),
            Err(PythonError::PayloadMissing(_))
        ));
    }
}
