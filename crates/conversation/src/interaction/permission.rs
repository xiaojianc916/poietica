use serde::{Deserialize, Serialize};

use crate::interaction::InteractionId;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub id: InteractionId,
    pub tool: String,
    pub scope: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionAnswer {
    Allow,
    AllowAlways,
    Deny,
}
