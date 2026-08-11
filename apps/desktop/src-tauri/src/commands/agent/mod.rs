//! The desktop seam onto the ACP client.
//!
//! Three rules shape this module.
//!
//! The session is started once and reused. A turn is cheap; a process and a
//! protocol handshake are not, and a session that restarted between turns
//! would throw away the context the agent has built up.
//!
//! 一段对话的持有者是 agent，不是这一侧。打开它就是请 agent 把它装载回来，
//! 重放的帧随 `agent_open_thread` 一起交出去。这一侧不再留第二份记录：本地
//! 库现在只是一张索引，记着有哪些对话、叫什么、各自握着谁的哪个会话。
//!
//! An answer arriving from the renderer is untrusted. The desk checks it
//! against the options the agent actually offered before anything is recorded
//! or sent.

use crate::error::IpcError;
use std::time::Duration;

/*
 * 本模块不做 re-export：命令与 DTO 一律按定义它们的子模块引用。
 *
 * #[tauri::command] 除函数外，还在同一个模块里生成 __cmd__x! 宏与
 * __tauri_command_name_x 常量（specta 再加 __specta__fn__x），而
 * generate_handler! 只会在你写的那条路径下找它们。pub use turn::agent_prompt
 * 只搬走四个符号里的一个，collect_commands! 当场报 could not find
 * __cmd__agent_prompt in agent；能搬全的只有 pub use turn::*，而 glob 让这个
 * 模块交出去的东西不可枚举。两条都不要：清单在 ipc::surface 一处，路径指向定义处。
 */
mod addressing;
mod attachment;
pub mod config;
pub mod dto;
mod failure;
mod kimi_state;
pub mod runtime;
pub mod thread;
pub mod turn;

type AgentCommandResult<T> = Result<T, IpcError>;

/// The event the renderer listens on to receive run frames.
pub const AGENT_EVENT: &str = "ai-run-event";

/// 会话自己报来的选择器表走这一条。
///
/// 与 [`AGENT_EVENT`] 分开，因为它们说的不是一件事：那一条是某一轮里的一帧，
/// 而这一条不属于任何一轮 —— agent 在 session/update 里推 `config_option_update`
/// 时可能正在答话，也可能没有。混进同一条通道，就得让渲染层去分辨，而分辨的
/// 依据只会是一个字符串标签。
pub const AGENT_SELECTOR_EVENT: &str = "ai-selector-report";

/// 会话自己报来的命令表走这一条。
///
/// 与上面那一条分开，理由与它和 [`AGENT_EVENT`] 分开完全一样：说的不是一件事。
/// 那一条回答"这条会话能改什么"，这一条回答"这条会话上敲得出什么" —— 内置命令、
/// agent 自己认得的技能、插件带来的，全在这一张表里，而它由 agent 算，不由本应用算。
pub const AGENT_COMMAND_EVENT: &str = "ai-command-report";

/// How much of the first message stands in as a conversation name.
const TITLE_CHARS: usize = 60;

/// 一拍的宽度：帧攒到这么久，就交货一次。
///
/// 六十赫兹的屏幕上，比这更密的投递没有人看得见 —— 收帧的那一侧也正是按这个
/// 节拍醒来的（见 transcript-store.ts 的 `#paint`）。
const FRAME_INTERVAL: Duration = Duration::from_millis(16);

const NO_SESSION: &str = "no agent session is running";
const POISONED: &str = "the agent session lock was left locked by a panicking task";
const NO_SESSION_ID: &str = "the agent closed the connection before creating a session";
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

/// 一张图大到账本里那一格装不下。
const IMAGE_TOO_LARGE: &str = "an attachment is too large";

/// 那两个令牌在交付注册表里指不到东西。
///
/// 到不了才是常态：令牌是输入框刚刚从原生侧拿到的，中间没有人关过那条会话。
/// 真的到了，说明这一句带的图已经不在了 —— 那就不该假装它还在，静默少发一张
/// 图比失败更坏，因为屏幕上什么都不会说。
const NO_SUCH_ASSET: &str = "an attachment is no longer available";

/// 一句话里的图片多到序号装不下。实际到不了，但转换要有个说法。
const TOO_MANY_IMAGES: &str = "too many attachments in one message";

/// 一句话只有图片时，这条对话叫什么。
///
/// 标题取自第一句话，而第一句话可以没有字。此前那一行直接 take 一个空串，
/// 于是列表里出现一条没有名字的对话。
const IMAGE_OPENER: &str = "[图片]";

/// 要停的那条对话此刻没有会话可发。
///
/// 这不是兜底：会话是在打开这条对话时才握上的，查不到恰好是「没有什么可停的」。
const NOTHING_TO_STOP: &str = "that conversation is not running";
