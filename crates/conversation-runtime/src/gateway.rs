//! KAP 投递边界；附件构造与收据解码不运行在数据库 actor 内。

use std::path::PathBuf;

use poietica_agent_client::{AgentClient, AgentError, PromptAttachment, PromptSkill};
use poietica_conversation::error::GatewayFailure;
use poietica_conversation::ports::{
    AgentGateway, DeliveryConfirmation, DeliveryReceipt, PromptDelivery,
};
use poietica_conversation::turn::{Admission, AttachmentRef};
use uuid::Uuid;

use crate::journal::FrameJournal;
use poietica_asset::blob::blob_path;
use poietica_ledger::index::ThreadAttachment;

#[derive(Clone)]
pub(crate) struct KapGateway {
    pub(crate) client: AgentClient,
    pub(crate) journal: FrameJournal,
    /// 附件字节的根。投递时按摘要把字节读回来。
    pub(crate) attachments_root: PathBuf,
}

// 连接句柄与帧日志可能携带大字节，Debug 只报结构不报字段。
impl core::fmt::Debug for KapGateway {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter.debug_struct("KapGateway").finish_non_exhaustive()
    }
}

impl AgentGateway for KapGateway {
    fn can_replay(&self, delivery: &PromptDelivery) -> bool {
        // Kimi 的 bundled skill 提交不接受 prompt_id，因此不能保证重发安全。
        delivery.admission.skills.is_empty()
    }

    fn deliver(&self, delivery: &PromptDelivery) -> Result<DeliveryReceipt, GatewayFailure> {
        self.journal
            .check()
            .map_err(|error| refusal(error.to_string()))?;
        let admission = &delivery.admission;
        let thread = Uuid::parse_str(admission.thread.as_str())
            .map_err(|error| refusal(format!("the thread id is not a uuid: {error}")))?;
        let carried = self.materialise(admission).map_err(refusal)?;
        let skills = admission
            .skills
            .iter()
            .map(|skill| PromptSkill {
                name: skill.name.clone(),
                args: skill.args.clone(),
            })
            .collect();

        let frames = self.journal.sink(thread);
        let answer = self
            .client
            .prompt(
                delivery.session.clone(),
                admission.prompt.clone(),
                carried,
                skills,
                admission.turn.as_str().to_owned(),
                frames,
            )
            .map_err(|error| refusal(error.to_string()))?;

        Ok(DeliveryReceipt::new(async move {
            match answer.await {
                Ok(Ok(prompt_id)) => DeliveryConfirmation::Accepted { prompt_id },
                Ok(Err(error)) => delivery_failure(&error),
                Err(error) => DeliveryConfirmation::Indeterminate {
                    reason: error.to_string(),
                },
            }
        }))
    }
}

/// 没上 wire 的失败。终局的裁决在收据线上，不在这里。
fn refusal(reason: String) -> GatewayFailure {
    GatewayFailure { reason }
}

impl KapGateway {
    /// Frozen attachments are all-or-nothing; never silently change a submitted prompt.
    ///
    /// 两条路都只交「磁盘绝对路径 + 元数据」：图片与通用文件在线上是不同的 content
    /// part，但字节一律不内联（base64 那条路拿不到服务端的 fileId，图片就不会进
    /// transcript，屏幕上彻底消失，见 ADR 0050）。
    fn materialise(&self, admission: &Admission) -> Result<Vec<PromptAttachment>, String> {
        let mut carried = Vec::with_capacity(admission.attachments.len());

        for reference in &admission.attachments {
            let path = blob_path(&self.attachments_root, &reference.hash)
                .map_err(|error| error.to_string())?;

            let prompt = if reference.mime.starts_with("image/") {
                PromptAttachment::Image {
                    path,
                    name: reference.name.clone(),
                }
            } else {
                PromptAttachment::File {
                    path,
                    name: reference.name.clone(),
                    mime_type: reference.mime.clone(),
                    size: reference.size,
                }
            };

            carried.push(prompt);
        }

        Ok(carried)
    }
}

/// 账面行与准入冻结行同形的一次换算。
pub(crate) fn attachment_reference(entry: &ThreadAttachment) -> AttachmentRef {
    AttachmentRef {
        hash: entry.hash.clone(),
        mime: entry.mime.clone(),
        name: entry.name.clone(),
        size: entry.byte_size,
    }
}

// 只接受上游提交路由在入队之前明确报告的拒绝；内部错误及 ID 冲突不能证明未入队。
fn delivery_failure(error: &AgentError) -> DeliveryConfirmation {
    let rejected = matches!(
        error,
        AgentError::Validation { .. }
            | AgentError::Envelope {
                code: 40_001 | 40_002 | 40_110
                    ..=40_113 | 40_401 | 40_407 | 40_415 | 40_901 | 40_912,
                ..
            }
    );
    let reason = error.to_string();
    if rejected {
        DeliveryConfirmation::Rejected { reason }
    } else {
        DeliveryConfirmation::Indeterminate { reason }
    }
}

#[cfg(test)]
mod delivery_confirmation_tests {
    use super::{AgentError, DeliveryConfirmation, delivery_failure};

    #[test]
    fn transport_loss_does_not_discharge_the_outbox() {
        for error in [
            AgentError::Transport {
                message: "lost response".to_owned(),
            },
            AgentError::Timeout {
                message: "no acknowledgement".to_owned(),
            },
            AgentError::Envelope {
                code: 50_001,
                message: "internal error".to_owned(),
            },
            AgentError::Envelope {
                code: 40_927,
                message: "id already present".to_owned(),
            },
        ] {
            assert!(matches!(
                delivery_failure(&error),
                DeliveryConfirmation::Indeterminate { .. }
            ));
        }
    }

    #[test]
    fn explicit_admission_refusal_is_terminal() {
        assert!(matches!(
            delivery_failure(&AgentError::Envelope {
                code: 40_001,
                message: "invalid request".to_owned()
            }),
            DeliveryConfirmation::Rejected { .. }
        ));
    }
}
