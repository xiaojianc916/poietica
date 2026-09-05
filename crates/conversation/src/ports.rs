use crate::error::{GatewayFailure, LedgerUnavailable};
use crate::event::{ConversationEvent, EventEnvelope};
use crate::identity::{Seq, ThreadId, TurnId};
use crate::turn::admission::{Admission, AdmissionDecision};
use crate::turn::delivery::{DeliveryOutcome, DeliveryState};

/// 一次投递的全部事实：冻结的意图，加上这一轮要去的会话地址。
///
/// 会话号是协议命名空间里的事实，由寻址方（组合根，经账本投影）解析出来；
/// 领域只负责把它和意图一起递给网关。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptDelivery {
    pub admission: Admission,
    pub session: String,
}

/// 账本：唯一真相的写入与读回。实现落在适配环，领域只认这个形状。
pub trait ConversationLedger {
    /// 幂等：同一 turn 再次提交只能得到 AlreadyAdmitted。
    fn admit(&self, admission: &Admission) -> Result<AdmissionDecision, LedgerUnavailable>;

    /// 追加一批事件；账本按对话发号并盖时戳。答的是带位置的完整信封 ——
    /// 上屏与重放用的是同一个形状。
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

    /// 欠着的投递：pending / sent / unknown。重启后由这里接上。
    fn unresolved_deliveries(&self) -> Result<Vec<Admission>, LedgerUnavailable>;
}

/// 投递端口声明重放能力；没有幂等依据时禁止恢复任务再次发送。
pub trait AgentGateway {
    fn can_replay(&self, delivery: &PromptDelivery) -> bool;
    /// Err 仅表示尚未交给传输层；送出后的结果必须通过收据返回。
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
