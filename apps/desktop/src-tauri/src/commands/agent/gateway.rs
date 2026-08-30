//! 领域 AgentGateway 端口在 KAP 上的实现。
//!
//! 端口形状与真实调用面在这里对上：准入里冻结的附件引用重建为协议内容块
//! （字节在盘上，内容寻址就是为此 —— 首次投递与崩溃后的重投递走同一条路），
//! 技能清单变换为 skill 激活，幂等键随载荷上 wire。帧不走网关：journal 在
//! 这里把这条会话的监听交出去，那是连接自己的事。

use std::path::PathBuf;
use std::sync::mpsc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use poietica_conversation::error::GatewayFailure;
use poietica_conversation::ports::{AgentGateway, DeliveryReceipt, PromptDelivery};
use poietica_conversation::turn::delivery::DeliveryOutcome;
use poietica_conversation::turn::{Admission, AttachmentRef};
use poietica_kap_client::{AgentClient, PromptAttachment, PromptSkill};
use tauri::async_runtime;
use uuid::Uuid;

use super::journal::FrameJournal;
use crate::asset_protocol::asset_protocol_url;
use crate::attachments::blob_path;
use poietica_ledger::index::ThreadAttachment;

pub(super) struct KapGateway {
    pub(super) client: AgentClient,
    pub(super) journal: FrameJournal,
    /// 附件字节的根。投递时按摘要把字节读回来。
    pub(super) attachments_root: PathBuf,
}

impl AgentGateway for KapGateway {
    fn deliver(&self, delivery: &PromptDelivery) -> Result<DeliveryReceipt, GatewayFailure> {
        let admission = &delivery.admission;
        let thread = Uuid::parse_str(admission.thread.as_str())
            .map_err(|error| refusal(format!("the thread id is not a uuid: {error}")))?;
        let carried = self
            .materialise(admission, &delivery.session)
            .map_err(|error| refusal(error.clone()))?;
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

        let (sender, receiver) = mpsc::channel();
        async_runtime::spawn(async move {
            let outcome = match answer.await {
                Ok(Ok(_accepted)) => DeliveryOutcome::Accepted,
                // server 当场拒收（带 code）是明确的拒绝；其余说不出成败。
                Ok(Err(_refused)) => DeliveryOutcome::Rejected,
                Err(_dropped) => DeliveryOutcome::Indeterminate,
            };
            let _sent = sender.send(outcome);
        });

        Ok(DeliveryReceipt::new(receiver))
    }
}

/// 没上 wire 的失败。终局的裁决在收据线上，不在这里。
fn refusal(reason: String) -> GatewayFailure {
    GatewayFailure { reason }
}

impl KapGateway {
    /// 把准入冻结的附件引用重建为协议载荷。
    ///
    /// 缺字节的那一张跳过而不挡整句：显示其余的部分与打开旧对话时的同一条
    /// 规矩（attachment.rs 的 deliver_attachments），缺的那张由日志记账。
    fn materialise(
        &self,
        admission: &Admission,
        session: &str,
    ) -> Result<Vec<PromptAttachment>, String> {
        let mut carried = Vec::with_capacity(admission.attachments.len());

        for reference in &admission.attachments {
            let path = blob_path(&self.attachments_root, &reference.hash)
                .map_err(|error| error.to_string())?;
            let bytes = match std::fs::read(&path) {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    log::warn!("an attachment's bytes are missing at delivery: {reference:?}");
                    continue;
                }
                Err(error) => return Err(error.to_string()),
            };

            let url = asset_protocol_url(session, &reference.hash)
                .map_err(|error| format!("{error:?}"))?;

            let prompt = if reference.mime.starts_with("image/") {
                PromptAttachment::Image {
                    data: BASE64.encode(bytes.as_slice()),
                    mime_type: reference.mime.clone(),
                    url,
                }
            } else if reference.mime == "text/plain" {
                let text = std::str::from_utf8(bytes.as_slice())
                    .map_err(|_utf8| "a text attachment is not UTF-8".to_owned())?
                    .to_owned();
                PromptAttachment::Text { text, url }
            } else {
                log::warn!("an attachment of this kind cannot be delivered: {reference:?}");
                continue;
            };

            carried.push(prompt);
        }

        Ok(carried)
    }
}

/// 账面行与准入冻结行同形的一次换算。
pub(super) fn attachment_reference(entry: &ThreadAttachment) -> AttachmentRef {
    AttachmentRef {
        hash: entry.hash.clone(),
        mime: entry.mime.clone(),
    }
}
