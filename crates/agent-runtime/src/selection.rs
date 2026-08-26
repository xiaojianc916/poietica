use std::collections::HashSet;

use futures::channel::oneshot;

use crate::commands::AgentClient;
use crate::config::ConfigControl;
use crate::error::{KapError, Refusal, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigSelection {
    pub id: String,
    pub value: String,
}

/// Writes the selections a prompt carries and returns the one authoritative
/// table.
///
/// 「要不要写」不在这一层判：同一个问题 driver 的 set_selector 已经答过，而它
/// 多认一样东西 —— 入参。目标开着时提交的那句话是新的 objective，在这里按
/// 「值没变」挡掉，它就没了。
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

    /// 每一项都原样交给写入侧，入参跟着走：目标开着时提交的那句话是新的
    /// objective，不能在这一层被「值没变」挡掉。
    #[tokio::test]
    async fn a_selection_carries_its_input_to_the_writer() {
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
                Some("ship the release".to_owned()),
            )
            .await
        });

        let Some(Command::Selectors { reply, .. }) = received.next().await else {
            return;
        };
        reply
            .send(Ok(vec![control("goal", ConfigPurpose::Mode, "on")]))
            .expect("selector table");

        let Some(Command::Select {
            config_id,
            value,
            input,
            reply,
            ..
        }) = received.next().await
        else {
            return;
        };

        assert_eq!(config_id, "goal");
        assert_eq!(value, "on");
        assert_eq!(input.as_deref(), Some("ship the release"));

        reply
            .send(Ok(vec![control("goal", ConfigPurpose::Mode, "on")]))
            .expect("written table");

        let applied = applying.await.expect("apply task").expect("apply");

        assert_eq!(applied.len(), 1);
    }
}
