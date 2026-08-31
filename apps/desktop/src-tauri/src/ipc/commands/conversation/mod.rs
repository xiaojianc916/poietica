//! The desktop seam onto the kap client.
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
//! An answer arriving from the renderer is untrusted, so its vocabulary is a
//! type: kap allows three decisions and one scope, and serde refuses anything
//! else at this boundary before a desk or the wire ever sees it.

use poietica_problem::Problem;

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
pub mod capability;
pub mod config;
pub mod custom_agents;
pub mod dto;
mod failure;
mod gateway;
mod journal;
pub mod runtime;
pub mod thread;
pub mod toolkit;
pub mod turn;

type AgentCommandResult<T> = Result<T, Problem>;

/// The event the renderer listens on to receive run frames.
pub const AGENT_EVENT: &str = "ai-run-event";

/// 会话自己报来的状态走这一条：选择器表与上下文用量。
///
/// 与 [`AGENT_EVENT`] 分开，因为它们说的不是一件事：那一条是某一轮里的一帧，
/// 这一条不属于任何一轮。两种同走一条、判别式在载荷里 —— 与运行帧同走
/// [`AGENT_EVENT`] 是同一条规矩。
pub const AGENT_SESSION_EVENT: &str = "ai-session-event";

/// How much of the first message stands in as a conversation name.
const TITLE_CHARS: usize = 60;

/// 一页历史包含的完整轮次数。单轮内部的流片在出 IPC 前压成 block。
const TURN_PAGE: i64 = 8;

/// 目录预览截到几个字。上界是预览卡的可见量：问一行，答三行（见
/// conversation-minimap.css 的 --cp-rail-card-line）。多存的字谁都看不见。
pub(crate) const OUTLINE_PROMPT_CHARS: i64 = 32;
pub(crate) const OUTLINE_REPLY_CHARS: i64 = 96;

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

/// 一句话只有图片时，这条对话叫什么。
///
/// 标题取自第一句话，而第一句话可以没有字。此前那一行直接 take 一个空串，
/// 于是列表里出现一条没有名字的对话。
const IMAGE_OPENER: &str = "[图片]";

/// 要停的那条对话此刻没有会话可发。
///
/// 这不是兜底：会话是在打开这条对话时才握上的，查不到恰好是「没有什么可停的」。
const NOTHING_TO_STOP: &str = "that conversation is not running";

/// 分叉要有一条真实持有、且属于当前 agent 的会话。
///
/// 还没人开口的对话没有会话；会话在别的 agent 手里的，号发过去只会换回
/// UnknownSession。两种都不该被静默降级成「新建一条空对话」。
const NOTHING_TO_FORK: &str = "that conversation has no session this agent could fork";
