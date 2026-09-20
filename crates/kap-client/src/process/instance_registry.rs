//! 就绪判据是认令牌而不是文件出现：start.ts 先 register 后 listen，端口还可能 +1 回填。

use std::path::Path;
use std::time::Duration;

use serde_json::Value;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;

use crate::error::{KapError, Result};
use crate::generated::rest::routes;
use crate::session::rest::envelope_data;

#[derive(Debug, Eq, PartialEq)]
enum Probe {
    Ready,
    Refused,
}

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

/// 用 /meta 不用 healthz：healthz 在免鉴权名单里谁都答得出来，/meta 认令牌才回 code 0。
async fn probe_instance(probe: &reqwest::Client, dial: &str, port: u16, token: &str) -> Probe {
    let Ok(url) = routes::meta(&format!("http://{dial}:{port}")) else {
        return Probe::Refused;
    };
    let Ok(response) = probe
        .get(url)
        .header(AUTHORIZATION, format!("Bearer {token}"))
        .send()
        .await
    else {
        return Probe::Refused;
    };
    let Ok(body) = response.json::<Value>().await else {
        return Probe::Refused;
    };
    let Ok(_data) = envelope_data(&body) else {
        return Probe::Refused;
    };
    // 不比 server_version：它随 npm 发版每版都动，官方客户端也从不比较；认令牌即我们拉起的 server。
    Probe::Ready
}

/// 等到注册表出现本次拉起之后的条目、且那个地址认我们的令牌；超时则报错。
/// 不比 pid（Windows 上直接子进程是 .cmd Shim，对不上）；令牌在此读，首次启动由 server 建，早读是空。
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

                    let address = format!("{dial}:{}", info.port);
                    match probe_instance(&probe, &dial, info.port, &token).await {
                        Probe::Ready => return Ok((info.host, info.port, token)),
                        Probe::Refused => {
                            if !refused.contains(&address) {
                                refused.push(address);
                            }
                        }
                    }
                }
            }
        }

        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

/// 通配绑定（0.0.0.0/::）拨回环；同一规则的另一份在 tools/contract/kap-spec-sync.ts 的 dialableHost。
pub(crate) fn dialable_host(host: &str) -> String {
    if host.is_empty() || host == "0.0.0.0" || host == "::" {
        return "127.0.0.1".to_owned();
    }

    if host.contains(':') {
        return format!("[{host}]");
    }

    host.to_owned()
}

async fn read_token(home_dir: &Path) -> Result<String> {
    let path = home_dir.join("server.token");
    tokio::fs::read_to_string(&path)
        .await
        .map(|s| s.trim().to_owned())
        .map_err(|e| KapError::Spawn {
            message: format!("cannot read server.token at {}: {e}", path.display()),
        })
}
