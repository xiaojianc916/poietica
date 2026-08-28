use crate::error::{GatewayFailure, LedgerUnavailable};
use crate::event::{ConversationEvent, EventEnvelope};
use crate::identity::{Seq, ThreadId, TurnId};
use crate::turn::admission::{Admission, AdmissionDecision};
use crate::turn::cancellation::CancelOrigin;
use crate::turn::delivery::{DeliveryOutcome, DeliveryState};

/// 账本：唯一真相的写入与读回。实现落在适配环，领域只认这个形状。
pub trait ConversationLedger {
    /// 幂等：同一 turn 再次提交只能得到 AlreadyAdmitted。
    fn admit(&self, admission: &Admission) -> Result<AdmissionDecision, LedgerUnavailable>;

    fn append(
        &self,
        thread: &ThreadId,
        event: &ConversationEvent,
    ) -> Result<Seq, LedgerUnavailable>;

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

    /// 欠着的投递：pending / sent / unknown。重启后由这里接上。
    fn unresolved_deliveries(&self) -> Result<Vec<Admission>, LedgerUnavailable>;
}

/// agent 网关：把一轮送出去。取消是显式请求，不是丢掉一个 future。
pub trait AgentGateway {
    fn deliver(&self, admission: &Admission) -> Result<DeliveryOutcome, GatewayFailure>;

    fn cancel(&self, turn: &TurnId, origin: CancelOrigin) -> Result<(), GatewayFailure>;
}
