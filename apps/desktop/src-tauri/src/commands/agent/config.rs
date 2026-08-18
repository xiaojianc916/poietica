//! 会话给出的那些选择器，以及改动它们。

use crate::error::Error;
use crate::local_index::LocalIndex;
use poietica_agent_runtime_native::{ConfigControl, ConfigPurpose};
use tauri::{AppHandle, State};

use super::addressing::session_for;
use super::dto::{
    AgentCapabilitiesRequest, AgentConfigChoice, AgentConfigControl, AgentConfigPurpose,
    AgentSelectConfigRequest,
};
use super::failure::translate;
use super::runtime::{AgentRuntime, borrow, ensure_session};
use super::{AgentCommandResult, NO_ANSWER, NO_SESSION};

/// Changes one selector, on one session.
///
/// 点名一条对话就发往它握着的那个会话；不点名就发往连接自带的锚会话 —— 入口那一格
/// 没有对话可以点名，而它画着的正是锚会话报的那张表。两个地址一个命令：拆成两条
/// 命令就等于让同一件事有两条代码路径，而其中一条迟早会长出自己的行为。
///
/// The change applies to the session in flight, so nothing is restarted
/// and nothing is written to the agent configuration file. The answer is
/// the whole list as the agent reports it afterwards, because one change
/// may add or remove another selector.
///
/// # Errors
///
/// Fails when no session is running, when a turn is in flight, or when
/// the agent refuses the value.
#[tauri::command]
#[specta::specta]
pub async fn agent_set_config_option(
    state: State<'_, AgentRuntime>,
    index: State<'_, LocalIndex>,
    request: AgentSelectConfigRequest,
) -> AgentCommandResult<Vec<AgentConfigControl>> {
    let live = borrow(&state)?.ok_or_else(|| Error::NotFound(NO_SESSION.to_owned()))?;

    /*
     * 发往谁：点名的那条对话，或者连接自带的锚会话。
     *
     * 点名时与提问走同一条 session_for：它认不得的会话号（上一次运行留下的）会在
     * 这里被换成一个新开的，而不是把一个 agent 不认识的名字发出去。锚会话不需要
     * 这一步 —— 它是 connect() 当场交回的那个号，本进程一直握着。
     */
    let AgentSelectConfigRequest {
        thread_id,
        config_id,
        value,
        ..
    } = request;

    let addressed = match thread_id.as_deref() {
        Some(named) => session_for(&state, &index, &live, named).await?.session_id,
        None => live.anchor.clone(),
    };

    let answer = live
        .client
        .select(addressed, config_id, value)
        .map_err(translate)?;
    let offered = answer
        .await
        .map_err(|_dropped| Error::Internal(NO_ANSWER.to_owned()))?
        .map_err(translate)?;

    Ok(offered.into_iter().map(restate).collect())
}

/// 这个 agent 提供哪些选择器。
///
/// 能力属于 agent，不属于某一轮对话 —— 模型清单在 ACP 里由 initialize 阶段的
/// 握手与 agent 自己的配置决定，一条会话只是从里面选了一个当前值。此前这张表
/// 只有两个出口，都要先有一个会话，而会话的归属要先有一条对话（`session_for`）：
/// 于是入口界面（还没有对话、也没有会话）在结构上不可能画出模型选择器，而渲染
/// 层只能拿上一次学到的表去缓存 —— 那是替一条不存在的取数路径打掩护。
///
/// 这里问的是锚会话：`connect()` 建立连接时本来就交回一个会话号，没有任何对话
/// 持有它。所以这条命令不新开会话、不写库、不碰任何 thread。
///
/// 它仍然会按需起进程：一个从没打开过助手的启动不该为此付钱，而一旦有人要看
/// 模型清单，进程就是要起的。
///
/// # Errors
///
/// Fails when the agent cannot be started, when a turn is in flight on the
/// connection, or when the agent refuses to report its selectors.
#[tauri::command]
#[specta::specta]
pub async fn agent_capabilities(
    app: AppHandle,
    state: State<'_, AgentRuntime>,
    request: AgentCapabilitiesRequest,
) -> AgentCommandResult<Vec<AgentConfigControl>> {
    let live = ensure_session(&app, &state, request.launch, request.cwd).await?;

    let answer = live.client.selectors(live.anchor).map_err(translate)?;

    let offered = answer
        .await
        .map_err(|_dropped| Error::Internal(NO_ANSWER.to_owned()))?
        .map_err(translate)?;

    Ok(offered.into_iter().map(restate).collect())
}

/// Restates one selector in the shape the generated bindings carry.
pub(super) fn restate(control: ConfigControl) -> AgentConfigControl {
    AgentConfigControl {
        id: control.id,
        label: control.label,
        detail: control.detail,
        purpose: match control.purpose {
            ConfigPurpose::Mode => AgentConfigPurpose::Mode,
            ConfigPurpose::Model => AgentConfigPurpose::Model,
            ConfigPurpose::Thought => AgentConfigPurpose::Thought,
            ConfigPurpose::Other => AgentConfigPurpose::Other,
        },
        current: control.current,
        choices: control
            .choices
            .into_iter()
            .map(|choice| AgentConfigChoice {
                value: choice.value,
                label: choice.label,
                detail: choice.detail,
            })
            .collect(),
    }
}
