use crate::error::{DomainFailure, GatewayFailure};
use crate::event::ConversationEvent;
use crate::ports::{AgentGateway, ConversationLedger, DeliveryReceipt, PromptDelivery};
use crate::turn::admission::AdmissionDecision;
use crate::turn::delivery::{DeliveryOutcome, DeliveryState};

/// 一次提交的结果：记账状态 + 终局还没到的那条线 + 没上 wire 的原因。
/// 失败不被吞，也不冒充成功。
#[derive(Debug)]
pub struct SubmitOutcome {
    pub delivery: DeliveryState,
    /// 终局在路上。settle 它的人负责 record_delivery；None = 没有终局可等。
    pub receipt: Option<DeliveryReceipt>,
    pub unresolved: Option<GatewayFailure>,
}

/// 领域的唯一入口：所有意图都从这里进，没有第二条代码路径。
///
/// 账本与网关都以引用注入：它们归组合根所有，这里只借来用一次。
pub struct Conversation<'a> {
    ledger: &'a dyn ConversationLedger,
    gateway: &'a dyn AgentGateway,
}

impl core::fmt::Debug for Conversation<'_> {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter.debug_struct("Conversation").finish()
    }
}

impl<'a> Conversation<'a> {
    pub fn new(ledger: &'a dyn ConversationLedger, gateway: &'a dyn AgentGateway) -> Self {
        Self { ledger, gateway }
    }

    /// 先冻结意图再投递；同一 turn 重放不会产生第二次投递。
    pub fn submit(&self, delivery: &PromptDelivery) -> Result<SubmitOutcome, DomainFailure> {
        if self.ledger.admit(&delivery.admission)? == AdmissionDecision::AlreadyAdmitted {
            let state = self
                .ledger
                .delivery_state(&delivery.admission.turn)?
                .unwrap_or(DeliveryState::Pending);

            return Ok(SubmitOutcome {
                delivery: state,
                receipt: None,
                unresolved: None,
            });
        }

        self.ledger.append(
            &delivery.admission.thread,
            &delivery.session,
            &[ConversationEvent::TurnAdmitted {
                turn: delivery.admission.turn.clone(),
            }],
        )?;

        self.dispatch(delivery)
    }

    /// 把一笔已经欠着的投递再送一遍（恢复路径）。
    ///
    /// 不再准入：意图早已冻结在账上，turn 是幂等键，server 收过就不重复入列。
    /// 会话地址由调用方解析好 —— 线程索引才有它，领域不背第二张寻址表。
    pub fn redeliver(&self, delivery: &PromptDelivery) -> Result<SubmitOutcome, DomainFailure> {
        self.dispatch(delivery)
    }

    fn dispatch(&self, delivery: &PromptDelivery) -> Result<SubmitOutcome, DomainFailure> {
        match self.gateway.deliver(delivery) {
            Ok(receipt) => Ok(SubmitOutcome {
                delivery: DeliveryState::Pending,
                receipt: Some(receipt),
                unresolved: None,
            }),
            // 端口契约：Err = 一个字节都没上 wire。当场结清，outbox 不欠账。
            Err(failure) => {
                let state = self
                    .ledger
                    .record_delivery(&delivery.admission.turn, DeliveryOutcome::Rejected)?;

                Ok(SubmitOutcome {
                    delivery: state,
                    receipt: None,
                    unresolved: Some(failure),
                })
            }
        }
    }
}
