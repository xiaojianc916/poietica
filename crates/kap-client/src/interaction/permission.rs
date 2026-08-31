//! 审批应答的领域模型。decision、scope、selected_label 与 feedback 共同构成
//! KAP approvalResponse；桌面边界只传这一份，不另建影子状态。

/// 「记住这个答复」的范围。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Scope {
    /// 这条会话余下的同类请求都照此办理。
    Session,
}

impl Scope {
    /// 线上那个词。
    #[must_use]
    pub const fn on_wire(self) -> &'static str {
        match self {
            Self::Session => "session",
        }
    }
}

/// 一次审批是怎么结的。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Decision {
    /// 放行。带上 scope 就是「这条会话都放行」。
    Approved { scope: Option<Scope> },
    /// 不放行。
    Rejected,
    /// 没有人答，这一轮先结束了。
    Cancelled,
}

/// 一次完整的 KAP 审批应答。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ApprovalResponse {
    pub decision: Decision,
    pub selected_label: Option<String>,
    pub feedback: Option<String>,
}

impl Decision {
    /// 线上那个 decision 词。
    #[must_use]
    pub const fn on_wire(self) -> &'static str {
        match self {
            Self::Approved { .. } => "approved",
            Self::Rejected => "rejected",
            Self::Cancelled => "cancelled",
        }
    }

    /// 随它一起发出去的范围；缺席就是只此一次。
    #[must_use]
    pub const fn scope(self) -> Option<Scope> {
        match self {
            Self::Approved { scope } => scope,
            Self::Rejected | Self::Cancelled => None,
        }
    }
}
