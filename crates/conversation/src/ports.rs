use crate::error::{GatewayFailure, LedgerUnavailable};
use crate::event::{ConversationEvent, EventEnvelope};
use crate::identity::{Seq, ThreadId, TurnId};
use crate::turn::admission::{Admission, AdmissionDecision};
use crate::turn::delivery::{DeliveryOutcome, DeliveryState};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptDelivery {
    pub admission: Admission,
    pub session: String,
}

/// 账本：唯一真相的唯一写入与读回路径；实现住在适配环，领域只认这个形状。
pub trait ConversationLedger {
    /// 相同冻结输入与 turn 幂等；准入、发件箱和准入事件原子地一起提交。
    fn admit(&self, delivery: &PromptDelivery) -> Result<AdmissionDecision, LedgerUnavailable>;

    fn append(
        &self,
        thread: &ThreadId,
        session: &str,
        events: &[ConversationEvent],
    ) -> Result<Vec<EventEnvelope>, LedgerUnavailable>;

    fn events_after(
        &self,
        thread: &ThreadId,
        after: Seq,
    ) -> Result<Vec<EventEnvelope>, LedgerUnavailable>;

    fn delivery_state(&self, turn: &TurnId) -> Result<Option<DeliveryState>, LedgerUnavailable>;

    fn record_delivery(
        &self,
        turn: &TurnId,
        outcome: DeliveryOutcome,
    ) -> Result<DeliveryState, LedgerUnavailable>;

    fn unresolved_deliveries(&self) -> Result<Vec<Admission>, LedgerUnavailable>;
}

/// 没有幂等依据时禁止恢复任务再次发送。
pub trait AgentGateway {
    fn can_replay(&self, delivery: &PromptDelivery) -> bool;
    /// Err 仅表示尚未交给传输层；送出后的结果必须经收据返回。
    fn deliver(&self, delivery: &PromptDelivery) -> Result<DeliveryReceipt, GatewayFailure>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeliveryConfirmation {
    Accepted { prompt_id: String },
    Rejected { reason: String },
    Indeterminate { reason: String },
}

impl DeliveryConfirmation {
    pub const fn outcome(&self) -> DeliveryOutcome {
        match self {
            Self::Accepted { .. } => DeliveryOutcome::Accepted,
            Self::Rejected { .. } => DeliveryOutcome::Rejected,
            Self::Indeterminate { .. } => DeliveryOutcome::Indeterminate,
        }
    }
}

pub struct DeliveryReceipt(std::pin::Pin<Box<dyn Future<Output = DeliveryConfirmation> + Send>>);

impl core::fmt::Debug for DeliveryReceipt {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("DeliveryReceipt")
            .finish_non_exhaustive()
    }
}

impl DeliveryReceipt {
    pub fn new(future: impl Future<Output = DeliveryConfirmation> + Send + 'static) -> Self {
        Self(Box::pin(future))
    }

    pub async fn settle(self) -> DeliveryConfirmation {
        self.0.await
    }
}
