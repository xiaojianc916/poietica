use crate::error::{DomainFailure, GatewayFailure};
use crate::event::ConversationEvent;
use crate::identity::TurnId;
use crate::ports::{AgentGateway, ConversationLedger};
use crate::turn::admission::{Admission, AdmissionDecision};
use crate::turn::cancellation::CancelOrigin;
use crate::turn::delivery::{DeliveryOutcome, DeliveryState};

/// 一次提交的结果：记账状态 + 没得到裁决的原因。失败不被吞，也不冒充成功。
#[derive(Debug)]
pub struct SubmitOutcome {
    pub delivery: DeliveryState,
    pub unresolved: Option<GatewayFailure>,
}

/// 领域的唯一入口：所有意图都从这里进，没有第二条代码路径。
#[derive(Debug)]
pub struct Conversation<L, G> {
    ledger: L,
    gateway: G,
}

impl<L: ConversationLedger, G: AgentGateway> Conversation<L, G> {
    pub fn new(ledger: L, gateway: G) -> Self {
        Self { ledger, gateway }
    }

    /// 先冻结意图再投递；同一 turn 重放不会产生第二次投递。
    pub fn submit(&self, admission: &Admission) -> Result<SubmitOutcome, DomainFailure> {
        if self.ledger.admit(admission)? == AdmissionDecision::AlreadyAdmitted {
            let delivery = self.ledger.delivery_state(&admission.turn)?;

            return Ok(SubmitOutcome {
                delivery: delivery.unwrap_or(DeliveryState::Pending),
                unresolved: None,
            });
        }

        self.ledger.append(
            &admission.thread,
            &ConversationEvent::TurnAdmitted {
                turn: admission.turn.clone(),
            },
        )?;

        self.deliver(admission)
    }

    /// 排空欠账：重启后把 pending / sent / unknown 重新送一次，turn 是幂等键。
    pub fn resume(&self) -> Result<Vec<(TurnId, SubmitOutcome)>, DomainFailure> {
        let mut settled = Vec::new();

        for admission in self.ledger.unresolved_deliveries()? {
            let outcome = self.deliver(&admission)?;

            settled.push((admission.turn.clone(), outcome));
        }

        Ok(settled)
    }

    pub fn cancel(&self, turn: &TurnId, origin: CancelOrigin) -> Result<(), GatewayFailure> {
        self.gateway.cancel(turn, origin)
    }

    fn deliver(&self, admission: &Admission) -> Result<SubmitOutcome, DomainFailure> {
        match self.gateway.deliver(admission) {
            Ok(outcome) => {
                let delivery = self.ledger.record_delivery(&admission.turn, outcome)?;

                Ok(SubmitOutcome {
                    delivery,
                    unresolved: None,
                })
            }
            // 网关报错意味着没有裁决：记成 unknown 留在账上，同时把原因交回去。
            Err(failure) => {
                let delivery = self
                    .ledger
                    .record_delivery(&admission.turn, DeliveryOutcome::Indeterminate)?;

                Ok(SubmitOutcome {
                    delivery,
                    unresolved: Some(failure),
                })
            }
        }
    }
}
