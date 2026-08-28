use crate::turn::state_machine::TurnState;

/// 同一对话同一时刻只有一轮在飞，其余排队。这是领域裁决，UI 不自己发明规则。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Interjection {
    Deliver,
    Queue,
}

pub fn decide(active: Option<&TurnState>) -> Interjection {
    match active {
        None => Interjection::Deliver,
        Some(state) if state.is_finished() => Interjection::Deliver,
        Some(_) => Interjection::Queue,
    }
}
