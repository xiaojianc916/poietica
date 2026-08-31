//! kap server 的实例注册表与令牌发现。
//!
//! 「等」的判据是认令牌，不是文件出现：start.ts 的第一行就 register，那时 server
//! 还没 listen，条目里的端口只是「要的那个」（DEFAULT_PORT 58627）；端口被占就
//! +1 往上走，绑上之后才 registration.update({ port: boundPort }) 回填真端口。
//! 文件先于监听存在，只信文件就会在这段窗口里拨到别人身上。

use std::path::Path;
use std::time::Duration;

use serde_json::Value;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;

use crate::error::{KapError, Result};
use crate::generated::rest::routes;
use crate::session::rest::envelope_data;

#[derive(serde::Deserialize)]
struct InstanceDisk {
    host: String,
    port: u16,
    /// 注册时刻（epoch 毫秒，server 写文件的 Date.now()），与本机同一个钟。
    started_at: i64,
}

impl InstanceDisk {
    fn eligible(content: &str, not_before: i64) -> Option<Self> {
        serde_json::from_str(content)
            .ok()
            .filter(|registration: &Self| registration.started_at >= not_before)
    }
}

/// 一次探针：这个地址上的 server 认不认我们手里这份令牌。
///
/// /meta 走全局 bearer 鉴权（start.ts 挂的 createAuthHook），认了才回 code 0。
/// 不能用 healthz —— 它在 defaultIsBypassed 的免鉴权名单里，谁都答得出来。
async fn accepts_token(probe: &reqwest::Client, dial: &str, port: u16, token: &str) -> bool {
    let Ok(url) = routes::meta(&format!("http://{dial}:{port}")) else {
        return false;
    };

    let Ok(response) = probe
        .get(url)
        .header(AUTHORIZATION, format!("Bearer {token}"))
        .send()
        .await
    else {
        return false;
    };

    let Ok(body) = response.json::<Value>().await else {
        return false;
    };

    envelope_data(&body).is_ok()
}

/// 等到注册表出现本次拉起之后的条目、且那个地址认我们的令牌，返回
/// (host, port, token)。超时则报错。
///
/// 判据是「认令牌」而不是「文件存在」：start.ts 的第一件事就是 register，那时
/// server 还没 listen，条目里的端口只是「要的那个」（DEFAULT_PORT 58627），端口
/// 被占就 +1 往上走，绑上之后才回填。只信文件就会在这段窗口里拨到 58627 上的
/// 别人身上 —— 上一次跑漏下的、或者另一个 home 起的 kimi —— 它拿 40101 顶回来。
///
/// 令牌也在这里读：它是判据的一部分，而且首次启动时是 server 自己把它建出来的，
/// 早读会读空。
///
/// 不比 pid：注册表记的是 server 自己的 pid，而 Windows 上我们拉起的直接子进程
/// 是 .cmd Shim，两边永远对不上。
pub(crate) async fn discover_instance(
    instances_dir: &Path,
    home_dir: &Path,
    not_before: i64,
    timeout: Duration,
) -> Result<(String, u16, String)> {
    let deadline = std::time::Instant::now() + timeout;

    let probe = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| KapError::Transport {
            message: e.to_string(),
        })?;

    let mut refused: Vec<String> = Vec::new();

    loop {
        if std::time::Instant::now() > deadline {
            let tried = if refused.is_empty() {
                "no registered instance answered".to_owned()
            } else {
                format!("these addresses refused it: {}", refused.join(", "))
            };

            return Err(KapError::Timeout {
                message: format!(
                    "no kap server under {} accepted the token at {} within {}s ({tried})",
                    instances_dir.display(),
                    home_dir.join("server.token").display(),
                    timeout.as_secs()
                ),
            });
        }

        // 令牌可能比注册表条目晚落地：首次启动时是 server 自己创建它的。
        let Some(token) = read_token(home_dir).await.ok().filter(|t| !t.is_empty()) else {
            tokio::time::sleep(Duration::from_millis(150)).await;
            continue;
        };

        if let Ok(mut dir) = tokio::fs::read_dir(instances_dir).await {
            while let Ok(Some(entry)) = dir.next_entry().await {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                if let Ok(content) = tokio::fs::read_to_string(&path).await
                    && let Some(info) = InstanceDisk::eligible(&content, not_before)
                {
                    let dial = dialable_host(&info.host);

                    if accepts_token(&probe, &dial, info.port, &token).await {
                        return Ok((info.host, info.port, token));
                    }

                    let address = format!("{dial}:{}", info.port);
                    if !refused.contains(&address) {
                        refused.push(address);
                    }
                }
            }
        }

        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

/// 注册表里的通配绑定（0.0.0.0 / ::）不是每个平台都能拨的地址，同一个监听器
/// 走回环一定到得了。同一规则的另一份在 tools/contract/kap-spec-sync.ts 的
/// dialableHost。
pub(crate) fn dialable_host(host: &str) -> String {
    if host.is_empty() || host == "0.0.0.0" || host == "::" {
        return "127.0.0.1".to_owned();
    }

    if host.contains(':') {
        return format!("[{host}]");
    }

    host.to_owned()
}

/// <home>/server.token 的内容（去首尾空白）。
async fn read_token(home_dir: &Path) -> Result<String> {
    let path = home_dir.join("server.token");
    tokio::fs::read_to_string(&path)
        .await
        .map(|s| s.trim().to_owned())
        .map_err(|e| KapError::Spawn {
            message: format!("cannot read server.token at {}: {e}", path.display()),
        })
}
