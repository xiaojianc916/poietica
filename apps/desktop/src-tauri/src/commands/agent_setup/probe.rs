//! 保存密钥之后，问那家厂商一句：这把钥匙你认不认。
//!
//! 为什么需要它：在此之前，界面对「已配置」的全部判据是
//! packages/agent-catalog/src/provider-state.ts 里的
//! configured = credentialKind != 'none'，也就是
//! 「那一格不是空的」。填错一个字符照样保存成功、照样点亮模型选择器，真相要等到
//! 几分钟后发第一条消息时，从一条来自完全另一条管线（kap 会话）的 401 里反推。
//!
//! 业界标杆都在保存那一刻验：Zed 的 `ApiKeyConfiguration` 保存时调
//! `authenticate()` 并回退卡片；VS Code Copilot 与 Continue 打 /models；
//! Postman 与 Docker Desktop 有显式的 Test connection。
//!
//! 为什么在原生侧发，两条理由，第二条是硬的：
//!   1. 密钥不该为了发请求而回到渲染层；
//!   2. tauri.conf.json 的 CSP 里 connect-src 'self'，渲染层 fetch 到
//!      api.deepseek.com 会被直接拦掉。原生请求不经 webview，不受这条约束。
//!      也就是说「在渲染层做」这个选项根本不存在。
//!
//! 地址白名单写死在这里，理由与 `agent_setup/cli.rs` 不接受渲染层传程序路径同源：这个
//! 应用会渲染 AI 输出，渲染层不是可信输入源，而一条「把用户密钥发到渲染层指定
//! 地址」的命令是现成的外泄原语。名单是三个字符串，不是把 TS 那张厂商表抄一份。
//!
//! 代价照实说：将来内置表加一家厂商，这三个字符串要跟着加。这是一处刻意接受的
//! 漂移，而且失败是关闭的 —— 名单里没有就回 Unsupported（「没能验证」），不会
//! 变成一次错误的「密钥不对」，更不会把密钥发到名单外的地方。
//!
//! 这条命令不写任何东西。密钥随请求进来、发完即弃，不落盘、不进日志。

use crate::error::{Error, IpcError};
use serde::Serialize;
use specta::Type;
use std::time::Duration;
use tauri::command;

type ProviderProbeCommandResult<T> = Result<T, IpcError>;

/// 一次探测最多等多久。这是一个保存动作的附属步骤，不是主线，宁可说「没能验证」
/// 也不要让用户对着转圈等下去。
const PROBE_TIMEOUT: Duration = Duration::from_secs(6);

/// 允许被探测的厂商域名。只接受 https。
const ALLOWED_HOSTS: [&str; 3] = ["api.deepseek.com", "open.bigmodel.cn", "api.moonshot.cn"];

/// 探测的结论。
///
/// 刻意把「密钥不对」和「没能验证」分成两类，而不是笼统的成功/失败：把一次网络
/// 抖动渲染成「你的密钥错了」，比根本不验证更糟 —— 那是软件在撒谎，用户会去改一
/// 把本来是对的钥匙。只有 401 才落到 Rejected。
#[derive(Clone, Copy, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ProviderProbeVerdict {
    /// 那家接受了这把密钥。注意它不等于「能用」：余额、配额、以及这把密钥对某个
    /// 具体模型的权限，都不在 /models 的回答范围内。
    Accepted,
    /// HTTP 401。密钥错、被吊销，或格式不对。
    Rejected,
    /// HTTP 403。密钥有效，但这个账号没有访问权限。
    Forbidden,
    /// 这家没有可用于校验的端点（404），或地址不在白名单里。不是失败。
    Unsupported,
    /// 超时、连不上、或其它状态码。关于密钥本身什么都不能下结论。
    Unreachable,
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProbeOutcome {
    pub verdict: ProviderProbeVerdict,
    /// HTTP 状态码。没有拿到响应时为 0。
    pub status: u16,
}

/// 地址必须恰好是白名单里某个主机下的 https 地址。
///
/// 不引 URL 解析器：前缀必须是 `https://主机名`，其后要么到头、要么紧跟一个斜杠 ——
/// 这就排除了 `https://api.deepseek.com.evil.tld` 与 userinfo 里塞主机名这两类写法。
fn is_allowed_base_url(base_url: &str) -> bool {
    ALLOWED_HOSTS.iter().any(|host| {
        let prefix = format!("https://{host}");

        base_url == prefix || base_url.starts_with(&format!("{prefix}/"))
    })
}

fn outcome(verdict: ProviderProbeVerdict, status: u16) -> ProviderProbeOutcome {
    ProviderProbeOutcome { verdict, status }
}

/// 用刚收到的密钥向厂商验一次身份。
///
/// 不写任何配置。调用方在写入成功之后才调它，所以无论结论如何都不影响已经落盘的
/// 那份配置 —— 这条命令只决定界面上那一行说什么。
///
/// # Errors
///
/// 密钥为空时返回参数错误。网络层的任何失败都不是错误，而是一个 Unreachable 的
/// 结论 —— 「没连上」是这次探测的正常输出之一，不该让调用方去 catch。
#[command]
#[specta::specta]
pub async fn provider_probe_key(
    base_url: String,
    secret: String,
) -> ProviderProbeCommandResult<ProviderProbeOutcome> {
    if secret.is_empty() {
        return Err(Error::Validation("没有可供验证的密钥".to_owned()).into());
    }

    if !is_allowed_base_url(&base_url) {
        return Ok(outcome(ProviderProbeVerdict::Unsupported, 0));
    }

    let url = format!("{}/models", base_url.trim_end_matches('/'));

    let client = reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .build()
        .map_err(|error| Error::Internal(format!("无法创建 HTTP 客户端：{error}")))
        .map_err(IpcError::from)?;

    // 失败的原因刻意不外带：reqwest 的错误串里可能有代理地址一类的本机信息，而
    // 界面要说的那句话不需要它。这与 error.rs 那张脱敏表是同一条纪律。
    let Ok(response) = client.get(&url).bearer_auth(&secret).send().await else {
        return Ok(outcome(ProviderProbeVerdict::Unreachable, 0));
    };

    let status = response.status().as_u16();

    match status {
        401 => return Ok(outcome(ProviderProbeVerdict::Rejected, status)),
        403 => return Ok(outcome(ProviderProbeVerdict::Forbidden, status)),
        404 => return Ok(outcome(ProviderProbeVerdict::Unsupported, status)),
        _ => {}
    }

    if !(200..300).contains(&status) {
        return Ok(outcome(ProviderProbeVerdict::Unreachable, status));
    }

    // 结论到此已经成立：那家已经用 2xx 接受了这把密钥。
    Ok(outcome(ProviderProbeVerdict::Accepted, status))
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        clippy::unwrap_used,
        clippy::panic,
        reason = "tests operate on known-good fixtures; a broken assumption must fail the test loudly"
    )]

    use super::is_allowed_base_url;

    #[test]
    fn builtin_hosts_are_allowed() {
        assert!(is_allowed_base_url("https://api.deepseek.com"));
        assert!(is_allowed_base_url("https://api.moonshot.cn/v1"));
        assert!(is_allowed_base_url("https://open.bigmodel.cn/api/paas/v4"));
    }

    #[test]
    fn lookalike_hosts_are_rejected() {
        assert!(!is_allowed_base_url("https://api.deepseek.com.evil.tld/v1"));
        assert!(!is_allowed_base_url("https://evil.tld/api.deepseek.com"));
        assert!(!is_allowed_base_url("https://api.deepseek.com@evil.tld/v1"));
    }

    #[test]
    fn plaintext_and_unknown_hosts_are_rejected() {
        assert!(!is_allowed_base_url("http://api.deepseek.com"));
        assert!(!is_allowed_base_url("https://api.openai.com/v1"));
        assert!(!is_allowed_base_url(""));
    }
}
