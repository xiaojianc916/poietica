//! 领域错误变成跨边界 Problem 的唯一一处。
//!
//! 一个变体一个码，没有兜底分支：新增变体在这里编译不过，而不是安静退化成 internal。

use poietica_problem::{Code, DiagnosticId, Problem};

use crate::error::Error;

impl From<Error> for Problem {
    fn from(error: Error) -> Self {
        Self::from(&error)
    }
}

impl From<&Error> for Problem {
    fn from(error: &Error) -> Self {
        let problem = Problem::new(code(error), DiagnosticId::issue());

        match reason(error) {
            Some(reason) => problem.with_detail("reason", reason),
            None => problem,
        }
    }
}

fn code(error: &Error) -> Code {
    match error {
        Error::Validation(_) => Code::RequestInvalid,
        Error::NotFound(_) => Code::ResourceMissing,
        Error::Io(_) | Error::File(_) => Code::FileUnavailable,
        Error::Store(_) => Code::SettingsUnavailable,
        Error::SerdeJson(_) => Code::ContractDecodeFailed,
        Error::Persistence(_) => Code::LedgerAppendFailed,
        Error::Asset(_) => Code::AssetRejected,
        Error::Plugin(_) => Code::PluginRejected,
        Error::AgentCli(_) => Code::AgentRejected,
        Error::Git(_) => Code::GitRejected,
        Error::Tauri(_) => Code::HostFailed,
        Error::Internal(_) => Code::Internal,
    }
}

/// 带得出「用户拿得去修正的理由」的那几个变体；其余不外传现场。
///
/// 插件失败在列：那句原因说的是服务器答了什么、清单在不在、归档解不开
/// （commands/extension.rs 的 plugin_failure），都是用户自己给的来源上的外部事实。
/// 剥掉它，装不上就只剩「插件操作失败」一句，人无从下手。
fn reason(error: &Error) -> Option<&str> {
    match error {
        Error::AgentCli(reason)
        | Error::Git(reason)
        | Error::Persistence(reason)
        | Error::Plugin(reason) => Some(reason),
        Error::Asset(_)
        | Error::File(_)
        | Error::Internal(_)
        | Error::Io(_)
        | Error::NotFound(_)
        | Error::SerdeJson(_)
        | Error::Store(_)
        | Error::Tauri(_)
        | Error::Validation(_) => None,
    }
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        reason = "测试跑在已知输入上，前提被打破就要当场炸"
    )]

    use super::{Code, Problem};
    use crate::error::Error;

    #[test]
    fn validation_becomes_a_request_problem_without_details() {
        let problem = Problem::from(Error::Validation("missing field".to_owned()));

        assert_eq!(problem.code, Code::RequestInvalid);
        assert!(problem.details.is_empty());
    }

    #[test]
    fn agent_rejection_carries_its_reason() {
        let problem = Problem::from(Error::AgentCli("只允许 provider list".to_owned()));

        assert_eq!(problem.code, Code::AgentRejected);
        assert_eq!(
            problem.details.get("reason").map(String::as_str),
            Some("只允许 provider list")
        );
    }

    #[test]
    fn plugin_rejection_carries_its_reason() {
        let problem = Problem::from(Error::Plugin("server answered 404 Not Found".to_owned()));

        assert_eq!(problem.code, Code::PluginRejected);
        assert_eq!(
            problem.details.get("reason").map(String::as_str),
            Some("server answered 404 Not Found")
        );
    }

    #[test]
    fn io_failure_does_not_leak_the_path() {
        let failure = std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "denied for /Users/example/secret.txt",
        );

        let problem = Problem::from(Error::Io(failure));

        assert_eq!(problem.code, Code::FileUnavailable);
        assert!(problem.details.is_empty());
    }
}
