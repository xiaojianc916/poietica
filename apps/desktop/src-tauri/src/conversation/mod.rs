//! Conversation host: platform capabilities, wire conversion and command registration.

use poietica_problem::Problem;

// Registration addresses definitions so Tauri command macros remain addressable.
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

/// 提问必须点名一条对话。
///
/// 绑定里这个字段是可选的，语义上不是：一轮问答会被记进账本，不点名就会记进
/// 「连接自带的那条对话」—— 一条屏幕上不存在的对话。在唯一能验证它的地方拒绝
/// 它，与下面 `conversation()` 拒绝一个非 UUID 的名字是同一件事。
///
/// 改设置不受这条约束：那件事不写账本，而入口那一格没有对话可以点名（见
/// `config::agent_set_config_option`）。
const NO_CONVERSATION: &str = "no conversation was named";

/// 点名的那条对话在库里没有行。
const NO_SUCH_CONVERSATION: &str = "that conversation no longer exists";

/// 一张图大到账本里那一格装不下。
const IMAGE_TOO_LARGE: &str = "an attachment is too large";

/// 那两个令牌在交付注册表里指不到东西。
///
/// 到不了才是常态：令牌是输入框刚刚从原生侧拿到的，中间没有人关过那条会话。
/// 真的到了，说明这一句带的图已经不在了 —— 那就不该假装它还在，静默少发一张
/// 图比失败更坏，因为屏幕上什么都不会说。
const NO_SUCH_ASSET: &str = "an attachment is no longer available";
