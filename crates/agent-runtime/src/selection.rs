use std::collections::HashSet;

use futures::channel::oneshot;

use crate::commands::AgentClient;
use crate::config::{ConfigControl, selector_patch};
use crate::error::{KapError, Refusal, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigSelection {
    pub id: String,
    pub value: String,
}

/// Writes the selections a prompt carries that are not already in force, and
/// returns the one authoritative table.
///
/// 校验只落在真的要写的那一项上：一项已经生效就没有请求，也就没有可校验的请求
/// —— 目标开着的时候提交一句话，不该被目标自己的入参规则拒掉。
pub async fn apply_configurations(
    client: &AgentClient,
    session_id: String,
    selections: Vec<ConfigSelection>,
    input: Option<String>,
) -> Result<Vec<ConfigControl>> {
    let mut ids = HashSet::new();
    for selection in &selections {
        if !ids.insert(selection.id.as_str()) {
            return Err(KapError::Validation {
                message: format!("prompt configuration repeats selector {}", selection.id),
            });
        }
    }

    let mut controls = receive(client.selectors(session_id.clone())?).await?;
    for selection in selections {
        if controls
            .iter()
            .any(|control| control.id == selection.id && control.current == selection.value)
        {
            continue;
        }
        let _validated = selector_patch(&selection.id, &selection.value, input.as_deref())?;
        controls = select_config(
            client,
            session_id.clone(),
            selection.id,
            selection.value,
            input.clone(),
        )
        .await?;
    }
    Ok(controls)
}

/// Changes one session control. The answer is the table the agent reports for
/// that write.
///
/// 收敛不由这一侧轮询判定：改一项可能增删另一项，而「改完之后是什么样」只有 agent
/// 说得算 —— 它会把收敛后的那张表自己推过来（配置更新推送，见 packages/agent-contract
/// 的 config.ts）。本地再立一个截止时间，等于给同一个事实设第二个权威，而那个权威
/// 只会更早、更容易说错。
pub async fn select_config(
    client: &AgentClient,
    session_id: String,
    config_id: String,
    value: String,
    input: Option<String>,
) -> Result<Vec<ConfigControl>> {
    receive(client.select(session_id, config_id, value, input)?).await
}

async fn receive(
    answer: oneshot::Receiver<Result<Vec<ConfigControl>>>,
) -> Result<Vec<ConfigControl>> {
    answer
        .await
        .map_err(|_dropped| KapError::Refused(Refusal::Gone))?
}

#[cfg(test)]
mod tests {
    // 与 tests/recorder.rs 顶上那一句同一条纪律、同一个理由（Cargo.toml lints
    // 注释）：测试里的 expect 是响亮失败，豁免只写在测试作用域，不靠根配置放开。
    #![allow(
        clippy::expect_used,
        reason = "a test proves itself by panicking, so a failed step must fail the test"
    )]

    use futures::StreamExt;

    use super::*;
    use crate::commands::Command;
    use crate::config::{ConfigChoice, ConfigPurpose};

    fn control(id: &str, purpose: ConfigPurpose, current: &str) -> ConfigControl {
        ConfigControl {
            id: id.to_owned(),
            label: id.to_owned(),
            detail: None,
            purpose,
            applies_on_submit: false,
            current: current.to_owned(),
            choices: vec![ConfigChoice {
                value: current.to_owned(),
                label: current.to_owned(),
                detail: None,
            }],
        }
    }

    /// 已经生效的那一项一个字都不写，也就不校验：目标开着的时候提交一句话，不该
    /// 被目标自己的入参规则拒掉。
    #[tokio::test]
    async fn a_selection_already_in_force_is_never_written() {
        let (commands, mut received) = futures::channel::mpsc::unbounded();
        let client = AgentClient::new(commands);
        let applying = tokio::spawn(async move {
            apply_configurations(
                &client,
                "session".to_owned(),
                vec![ConfigSelection {
                    id: "goal".to_owned(),
                    value: "on".to_owned(),
                }],
                None,
            )
            .await
        });

        let Some(Command::Selectors { reply, .. }) = received.next().await else {
            return;
        };
        reply
            .send(Ok(vec![control("goal", ConfigPurpose::Mode, "on")]))
            .expect("selector table");

        let applied = applying.await.expect("apply task").expect("apply");

        assert_eq!(applied.len(), 1);
        assert!(received.next().await.is_none());
    }
}
