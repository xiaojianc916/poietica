//! 一次运行的事件契约。
//!
//! 这里是帧形状在整个仓库里的唯一定义处。它是一个强类型 enum 而不是一串
//! `json!` 字面量，所以字段名拼错是编译错误，而不是一个要靠界面侧第二份
//! schema 在运行期抓出来的问题。
//!
//! 判别式与字段名由 serde 派生：`kind` 用协议的 `snake_case`，字段用界面读的
//! `camelCase`。同一条原则 `session.rs` 取 stop reason 时已经在用 ——
//! 「wire 形态就是契约，所以取自序列化而不是手写映射」。
//!
//! `prune` 与 `normalize` 规范化的是 SDK 的序列化行为，不是兼容层：`Option`
//! 会序列化成 null，而带默认值的字段会被整个省略。前者对界面而言与「没有」
//! 同义，后者会让一个 tool call 的首帧缺标题。两者都是第三方序列化的产物，
//! 所以在帧离开这一层之前就抹平。

use agent_client_protocol::schema::v1::{SessionNotification, SessionUpdate, ToolCall};
use serde::Serialize;
use serde_json::Value;

/// 一轮的第一帧。
pub const RUN_STARTED: &str = "run_started";
/// agent 发来的一帧会话通知。
/// deepseek-harness 会话日志事件那一帧的判别值。
pub const HARNESS_EVENT: &str = "harness_event";

pub const ACP_UPDATE: &str = "acp_update";
/// agent 正卡在一次授权请求上。
pub const PERMISSION_REQUESTED: &str = "permission_requested";
/// 那次授权请求得到的答复。
pub const PERMISSION_RESOLVED: &str = "permission_resolved";
/// 这一轮按 agent 自己的说法结束了。
pub const RUN_FINISHED: &str = "run_finished";
/// 这一轮以失败结束。
pub const RUN_FAILED: &str = "run_failed";

/// 一条会话通知，按界面读到的形状。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameNotification {
    /// 这一帧属于哪条 ACP 会话。
    pub session_id: String,
    /// 协议原样交回来的更新，已规范化。
    pub update: Value,
}

/// 一次运行里可能发生的六种事。
///
/// `acp_update` 承载协议通知原文；其余五种是协议不建模、而客户端必须记住的
/// 事实。每一种都带 `seq` 与 `at`（见 `RecordedEvent`），所以重放是确定的。
#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum RunFrame {
    /// harness 运行时报来的一条会话日志事件，线上形状原样。
    ///
    /// 与 AcpUpdate 同一条规矩：载荷是协议原文，这一层不解释它。
    #[serde(rename_all = "camelCase")]
    HarnessEvent {
        session_id: String,
        event: Value,
    },
    /// 这一轮开始了，以及问的是什么。
    RunStarted {
        /// 人说的那句话，按记录时的原文。
        prompt: String,
    },
    /// agent 发来的一帧会话通知。
    AcpUpdate {
        /// 通知本体。
        notification: FrameNotification,
    },
    /// agent 正卡在一次授权请求上。
    PermissionRequested {
        /// 用来把请求与答复对起来的标识，由客户端铸造。
        request_id: String,
        /// 被问到的那次工具调用。
        tool_call_id: String,
        /// 界面必须显示的标题；协议里它是可选的。
        title: String,
        /// 被征求同意的那次操作，按协议送来的形状。
        tool_call: Value,
        /// agent 给出的选项。
        options: Value,
    },
    /// 那次授权请求是怎么结束的。
    PermissionResolved {
        /// 被结清的那个请求。
        request_id: String,
        /// 选中的选项；取消时为空。
        option_id: String,
        /// selected 或 cancelled。
        outcome: String,
    },
    /// 这一轮按 agent 自己的说法结束了。
    RunFinished {
        /// agent 报的停止原因。
        stop_reason: String,
        /// 协议什么都没说时，agent 在自己错误流上的说法。
        #[serde(skip_serializing_if = "Option::is_none")]
        diagnostics: Option<String>,
    },
    /// 这一轮以失败结束。
    RunFailed {
        /// 我们的说法。
        message: String,
        /// agent 自己的说法，优先于上面那条。
        #[serde(skip_serializing_if = "Option::is_none")]
        diagnostics: Option<String>,
    },
}

impl RunFrame {
    /// 这一帧在日志里记作哪一类。返回的就是 wire 上的判别式。
    #[must_use]
    pub const fn kind(&self) -> &'static str {
        match self {
            Self::HarnessEvent { .. } => HARNESS_EVENT,
            Self::RunStarted { .. } => RUN_STARTED,
            Self::AcpUpdate { .. } => ACP_UPDATE,
            Self::PermissionRequested { .. } => PERMISSION_REQUESTED,
            Self::PermissionResolved { .. } => PERMISSION_RESOLVED,
            Self::RunFinished { .. } => RUN_FINISHED,
            Self::RunFailed { .. } => RUN_FAILED,
        }
    }
}

/// 删掉 null 成员。它们是 `Option::None` 的产物，对界面而言与缺席同义。
pub(crate) fn prune(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            fields.retain(|_name, member| {
                if member.is_null() {
                    return false;
                }

                prune(member);

                true
            });
        }
        Value::Array(members) => {
            for member in members.iter_mut() {
                prune(member);
            }
        }
        _ => {}
    }
}

/// 把一个序列化后的会话更新抹平成界面读的形状。
///
/// 除了剪除 null，还把序列化时因取默认值而被省略的展示字段按 SDK 自己的值
/// 补回来。补回来的值走的是同一个序列化器，所以这是还原而不是发明。
///
/// # Errors
///
/// 补回字段需要再序列化一次协议枚举，失败时报错。
pub(crate) fn normalize(value: &mut Value, update: &SessionUpdate) -> serde_json::Result<()> {
    prune(value);

    if let SessionUpdate::ToolCall(call) = update {
        restore_tool_call(value, call)?;
    }

    Ok(())
}

/// 把一条会话通知做成一帧。
///
/// 实时的一轮与装载期的重播都走这里，所以两边的帧一模一样 —— 一条对话重开
/// 之后，与当时看着它发生，不可能有出入。
///
/// 实时那条路上它跑在 SDK 的通知处理器里，而那个处理器是原子的：这一趟
/// `to_value` 加递归 `prune` 没做完，这条连接上不会再处理任何一条消息
/// （driver.rs 的 `on_receive_request` 引的是同一节 SDK 规约）。agent 的标准输出
/// 因此以它为节拍被读取。挪离那个处理器的前提是六种帧一起过同一道边界：只挪这
/// 一种，终帧会越过还没成形的更新帧，而序号线的单调正是界面去重的依据。
///
/// # Errors
///
/// 序列化协议更新失败时报错。
///
/// 对外的理由与帧本身相同：两条驱动线与集成测试都从这里成帧，不另造第二份。
pub fn acp_update(notification: &SessionNotification) -> serde_json::Result<RunFrame> {
    let mut update = serde_json::to_value(&notification.update)?;

    normalize(&mut update, &notification.update)?;

    Ok(RunFrame::AcpUpdate {
        notification: FrameNotification {
            session_id: notification.session_id.to_string(),
            update,
        },
    })
}

fn restore_tool_call(value: &mut Value, call: &ToolCall) -> serde_json::Result<()> {
    restore(value, "title", || Ok(Value::String(call.title.clone())))?;
    restore(value, "kind", || serde_json::to_value(call.kind))?;
    restore(value, "status", || serde_json::to_value(call.status))?;

    Ok(())
}

/// 补一个字段，值到用时才做。
///
/// 三个默认值通常一个都不缺，而 `title` 要克隆一次字符串、另外两个各要走一趟
/// 序列化。先做出来再判断要不要，就是三份白扔的分配 —— 与 `unwrap_or_else`
/// 相对于 `unwrap_or` 是同一件事。
fn restore(
    update: &mut Value,
    field: &str,
    value: impl FnOnce() -> serde_json::Result<Value>,
) -> serde_json::Result<()> {
    if let Value::Object(fields) = update
        && !fields.contains_key(field)
    {
        let _absent = fields.insert(field.to_owned(), value()?);
    }

    Ok(())
}
