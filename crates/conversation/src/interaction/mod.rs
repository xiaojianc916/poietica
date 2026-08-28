pub mod permission;
pub mod question;

use core::fmt;

use serde::{Deserialize, Serialize};

use crate::interaction::permission::{PermissionAnswer, PermissionRequest};
use crate::interaction::question::{Answer, Question};

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct InteractionId(String);

impl InteractionId {
    pub fn new(value: String) -> Self {
        Self(value)
    }

    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

impl fmt::Display for InteractionId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0.as_str())
    }
}

/// agent 会停下来等的所有事情。封闭联合，回答它的地方只有一处。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum InteractionRequest {
    Permission(PermissionRequest),
    Question(Question),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum InteractionAnswer {
    Permission(PermissionAnswer),
    Question(Answer),
}

impl InteractionRequest {
    pub fn id(&self) -> &InteractionId {
        match self {
            Self::Permission(request) => &request.id,
            Self::Question(question) => &question.id,
        }
    }

    /// 答案与问题必须同类；错配是拒绝，不是就地修好。
    pub fn accepts(&self, answer: &InteractionAnswer) -> bool {
        matches!(
            (self, answer),
            (Self::Permission(_), InteractionAnswer::Permission(_))
                | (Self::Question(_), InteractionAnswer::Question(_))
        )
    }
}
