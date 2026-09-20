//! decision、scope、selected_label 与 feedback 共同构成 KAP 的 approvalResponse。

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Scope {
    Session,
}

impl Scope {
    #[must_use]
    pub const fn on_wire(self) -> &'static str {
        match self {
            Self::Session => "session",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Decision {
    Approved { scope: Option<Scope> },
    Rejected,
    Cancelled,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ApprovalResponse {
    pub decision: Decision,
    pub selected_label: Option<String>,
    pub feedback: Option<String>,
}

impl Decision {
    #[must_use]
    pub const fn on_wire(self) -> &'static str {
        match self {
            Self::Approved { .. } => "approved",
            Self::Rejected => "rejected",
            Self::Cancelled => "cancelled",
        }
    }

    #[must_use]
    pub const fn scope(self) -> Option<Scope> {
        match self {
            Self::Approved { scope } => scope,
            Self::Rejected | Self::Cancelled => None,
        }
    }
}
