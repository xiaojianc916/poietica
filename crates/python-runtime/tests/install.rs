/*!
端到端装机：真取清单 → 真下载 → 真校验 → 真解包 → 真跑解释器。需要网络与约 22MB 下载，
所以默认不跑：

```
cargo test -p poietica-python-native --test install -- --ignored --nocapture
```

它抓到过两个只有真网络才现形的缺陷，故此留在这里而不是当一次性探针删掉：
1. 清单请求带了 `Accept: application/vnd.github+json` → GitHub 回压缩体，而 client 没开
   解码 feature，`.json()` 报 "error decoding response body"（内存 JSON 的单测看不见）。
2. 解释器在安装树里的位置：受管目录**自己就是家目录**，\`<target>/python.exe\` 而不是
   二级同名目录（`executable_of` 的判据）。
*/

#![allow(
    clippy::expect_used,
    reason = "端到端测试：任何一步失败都必须让测试当场失败，占位返回会掩盖装机缺陷"
)]

use poietica_python_native as p;

#[tokio::test]
#[ignore = "需要网络：下载约 22MB 的 CPython"]
async fn installs_a_runnable_cpython_and_reports_ready() {
    let base = std::env::temp_dir().join("poietica-python-e2e");
    let target = base.join("tools").join("python");
    let stage = p::stage_directory(&target);

    let asset = p::fetch_asset().await.expect("取清单");
    assert_eq!(
        asset.size, 22_013_771,
        "上游换了资产，先核对再改这里的期望值"
    );

    let archive = p::archive_in(&stage);
    let cached = std::fs::metadata(&archive).map_or(0, |m| m.len()) == asset.size;
    if !cached {
        p::download(&asset, &archive).await.expect("下载并校验摘要");
    }

    p::install(&archive, &stage, &target)
        .await
        .expect("解包、自检、换入");
    assert_eq!(
        p::inspect(&stage, &target).await,
        p::InstallationState::Ready
    );

    let exe = target.join("python.exe");
    assert!(exe.is_file(), "解释器应当在受管目录根上：{}", exe.display());

    let output = tokio::process::Command::new(&exe)
        .args(["-c", "import sys;print(sys.version_info[:2])"])
        .output()
        .await
        .expect("跑解释器");
    assert!(output.status.success());
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "(3, 12)");
}
