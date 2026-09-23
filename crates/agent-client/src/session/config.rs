//! 会话可调项的形状。
//!
//! 旧文件是把 kap 的 status/models/goal 三份 wire 投影成产品控制项（710 行）。
//! 桥这条路不需要那层投影：桥报上来的就是这几格（packages/agent-bridge 的
//! SelectorControl），通用层不再认识任何一家的清单形状。留在这里的是产品侧的
//! 那份词汇 —— 界面与运行时按它说话。

/// 一个控制项管的是哪件事。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigPurpose {
    Permission,
    Mode,
    Model,
    Thought,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigChoice {
    pub value: String,
    pub label: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigControl {
    pub id: String,
    pub label: String,
    pub detail: Option<String>,
    pub purpose: ConfigPurpose,
    pub applies_on_submit: bool,
    pub current: String,
    pub choices: Vec<ConfigChoice>,
}

/// agent 报上来的目标。字段是产品词汇，不是任何一家的 wire 名。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoalSnapshot {
    pub objective: String,
    pub completion_criterion: Option<String>,
    pub status: String,
    pub turns_used: u64,
    pub tokens_used: u64,
    pub wall_clock_ms: u64,
}
