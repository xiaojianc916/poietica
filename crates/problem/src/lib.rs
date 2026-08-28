//! 跨进程、跨语言的唯一错误词汇。
//!
//! 这里只回答「错误是什么」。文案由前端目录按 user_message_key 决定，
//! 现场细节由 diagnostic_id 串起日志。

pub mod category;
pub mod code;
pub mod diagnostic;
pub mod problem;
pub mod redaction;
pub mod retry;

pub use category::Category;
pub use code::Code;
pub use diagnostic::DiagnosticId;
pub use problem::Problem;
pub use retry::Retryability;
