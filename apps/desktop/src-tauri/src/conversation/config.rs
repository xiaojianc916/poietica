//! 会话给出的那些选择器，以及改动它们。

use crate::error::Error;
use crate::ledger::LocalIndex;
use poietica_kap_client::{AgentClient, ConfigControl, ConfigPurpose, select_config};
use tauri::{AppHandle, State};
use tauri_specta::Event as _;

use super::dto::{
    AgentCapabilitiesRequest, AgentConfigChoice, AgentConfigControl, AgentConfigPurpose,
    AgentSelectConfigRequest, AgentSessionEvent, reported_goal,
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
    app: AppHandle,
    state: State<'_, AgentRuntime>,
    index: State<'_, LocalIndex>,
    request: AgentSelectConfigRequest,
) -> AgentCommandResult<Vec<AgentConfigControl>> {
    let live = borrow(&state)?.ok_or_else(|| Error::NotFound(NO_SESSION.to_owned()))?;

    let AgentSelectConfigRequest {
        thread_id,
        config_id,
        value,
        input,
    } = request;

    let held = match thread_id.as_deref() {
        Some(named) => Some(
            state
                .sessions
                .resolve(
                    &index,
                    &live.client,
                    &live.book,
                    &live.agent_id,
                    &state.root,
                    named,
                )
                .await
                .map_err(Error::from)?,
        ),
        None => None,
    };
    let addressed = held
        .as_ref()
        .map_or_else(|| live.anchor.clone(), |held| held.session_id.clone());

    let offered = select_config(&live.client, addressed.clone(), config_id, value, input)
        .await
        .map_err(translate)?;

    announce(&app, &live.client, addressed).await;

    Ok(offered.into_iter().map(restate).collect())
}

/// Reads selectors from the connection anchor without creating a conversation.
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

/// 会话此刻的选择器表与目标账目，一起报给渲染层。
///
/// 目标归 agent，这一条是它到屏幕的唯一路径：所以每个动得了它的动作 —— 改选择器、
/// 发起一轮、一轮收尾、取消 —— 事后都调它一次。报不出来只记日志：那个动作本身已经
/// 做完了，这里再失败也不该把它变成失败。
pub(super) async fn announce(app: &AppHandle, client: &AgentClient, session_id: String) {
    let asked = match client.selectors(session_id.clone()) {
        Ok(answer) => answer,
        Err(error) => {
            log::warn!("the session selectors could not be asked for: {error}");
            return;
        }
    };

    let selectors: Vec<AgentConfigControl> = match asked.await {
        Ok(Ok(offered)) => offered.into_iter().map(restate).collect(),
        Ok(Err(error)) => {
            log::warn!("the agent refused to report its selectors: {error}");
            return;
        }
        Err(_dropped) => {
            log::warn!("the session ended before reporting its selectors");
            return;
        }
    };

    let goal = match client.goal(session_id.clone()).await {
        Ok(reported) => reported.map(reported_goal),
        Err(error) => {
            log::warn!("the goal could not be read: {error}");
            return;
        }
    };

    let event = AgentSessionEvent::Selectors {
        session_id,
        selectors,
        goal,
    };

    if let Err(error) = event.emit(app) {
        log::warn!("emit the session state failed: {error}");
    }
}

/// Restates one selector in the shape the generated bindings carry.
pub(super) fn restate(control: ConfigControl) -> AgentConfigControl {
    AgentConfigControl {
        id: control.id,
        label: control.label,
        detail: control.detail,
        purpose: match control.purpose {
            ConfigPurpose::Permission => AgentConfigPurpose::Permission,
            ConfigPurpose::Mode => AgentConfigPurpose::Mode,
            ConfigPurpose::Model => AgentConfigPurpose::Model,
            ConfigPurpose::Thought => AgentConfigPurpose::Thought,
            ConfigPurpose::Other => AgentConfigPurpose::Other,
        },
        applies_on_submit: control.applies_on_submit,
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
