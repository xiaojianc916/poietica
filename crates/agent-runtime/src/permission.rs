//! 审批的答复。
//!
//! 取值域是封闭的，而且是协议定的：decision 三个词，scope 一个词
//! （protocol/approval.ts 的 approvalResponseSchema 与 approvalScopeSchema）。
//! 所以这里是两个枚举，不是一张由这一侧合成、再由这一侧自己校验的选项表 ——
//! kap 的审批请求里根本没有选项这个对象。

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
