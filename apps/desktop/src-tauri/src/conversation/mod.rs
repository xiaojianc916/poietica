//! 会话宿主：平台能力、线上形状转换与命令注册。

use poietica_problem::Problem;

mod attachment;
pub mod capability;
pub(crate) mod composition;
pub mod config;
mod configuration;
pub mod custom_agents;
pub mod dto;
pub mod export;
mod failure;
pub mod model_catalog;
pub(crate) type AgentRuntime =
    std::sync::Arc<poietica_conversation_runtime::Runtime<crate::error::Error>>;
pub mod thread;
pub mod toolkit;
pub mod turn;

type AgentCommandResult<T> = Result<T, Problem>;

const NO_SESSION: &str = "no agent session is running";
const POISONED: &str = "the agent session lock was left locked by a panicking task";
const NO_ANSWER: &str = "the agent session ended before answering";
const NO_READ: &str = "the database read did not finish";

/// 提问必须点名一条对话：绑定里字段可选但语义上必选，否则问答会记进账本里屏幕上不存在的那条；改设置不受此约束。
const NO_CONVERSATION: &str = "no conversation was named";

const NO_SUCH_CONVERSATION: &str = "that conversation no longer exists";

const IMAGE_TOO_LARGE: &str = "an attachment is too large";
