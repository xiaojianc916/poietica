//! 连接链路态，只有状态：重连策略住在 kap-client 的 link.rs；「模型半天不说话」是轮次的事，由轮次封条表达，不从这里冒充断线。

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum LinkState {
    Retrying {
        attempt: u32,
        of: u32,
        retry_at: i64,
        reason: String,
    },
    Recovered { reason: String },
    Severed { attempts: u32, reason: String },
}
