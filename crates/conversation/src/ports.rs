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

/// agent 网关：把一轮送到它的会话地址。
///
/// 端口形状对准 KAP 的真实调用面（session + 文本 + 附件 + 技能 + 幂等键），
/// 协议载荷的成形（内容块、skill 激活）是实现方自己的事 —— 领域只冻结意图
/// 与指派地址。帧不走这里：连接自己的事件流是帧的家。取消不在端口里：它是
/// 一条会话上的传输动作（与 steer 同族，随帧记账），不参与投递的持久化管线。
pub trait AgentGateway {
    /// 送出一轮。Ok 时收据线在手里：终局（接受/拒绝/未知）由它带回来，
    /// 等到的人负责 record_delivery。Err = 一个字节都没上 wire，记 rejected 安全。
    fn deliver(&self, delivery: &PromptDelivery) -> Result<DeliveryReceipt, GatewayFailure>;
}

/// 一轮送出去之后回到手里的线。阻塞等终局只在专门的收尾任务上做。
pub struct DeliveryReceipt(std::sync::mpsc::Receiver<DeliveryOutcome>);

impl core::fmt::Debug for DeliveryReceipt {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter.debug_struct("DeliveryReceipt").finish()
    }
}

impl DeliveryReceipt {
    pub fn new(receiver: std::sync::mpsc::Receiver<DeliveryOutcome>) -> Self {
        Self(receiver)
    }

    /// 终局。等待方先退场（连接没了、进程在退）时是 None —— 那正是 unknown：
    /// 发出去没有等到裁决，重启后由 unresolved_deliveries 接上。
    pub fn settle(self) -> Option<DeliveryOutcome> {
        self.0.recv().ok()
    }
}
