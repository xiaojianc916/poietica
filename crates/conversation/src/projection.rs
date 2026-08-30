use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::event::{ConversationEvent, EventEnvelope};
use crate::identity::{Seq, ThreadId, TurnId};
use crate::turn::state_machine::{TurnCompletion, TurnState};

/// 这一轮正等着的回答属于哪一类。请求与答复的配对键是 agent 签发的那一个号。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OpenInteraction {
    Permission,
    Question,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnView {
    pub turn: TurnId,
    pub state: TurnState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadView {
    pub thread: ThreadId,
    pub last_seq: Seq,
    pub turn_order: Vec<TurnId>,
    pub turns: BTreeMap<TurnId, TurnView>,
    /// 还在等回答的交互，按 agent 签发的号。
    pub open_interactions: BTreeMap<String, OpenInteraction>,
    /// 本投影还没学会折的事件数；缺口可见才能被逐个补上。
    pub unparsed_events: u64,
}

impl ThreadView {
    pub fn empty(thread: ThreadId) -> Self {
        Self {
            thread,
            last_seq: Seq::NONE,
            turn_order: Vec::new(),
            turns: BTreeMap::new(),
            open_interactions: BTreeMap::new(),
            unparsed_events: 0,
        }
    }

    /// 实时流与冷重放走的是同一个函数，所以两边不会各说各话。
    pub fn apply(&mut self, envelope: &EventEnvelope) {
        self.last_seq = envelope.seq;

        match &envelope.event {
            ConversationEvent::TurnAdmitted { turn } => {
                self.ensure_turn(turn.clone()).state = TurnState::Admitted;
            }
            ConversationEvent::PromptAdmitted { admission_id, .. } => {
                self.ensure_turn(admission_id.clone()).state = TurnState::Admitted;
            }
            ConversationEvent::RunFinished { turn, stop_reason } => {
                let Some(turn) = turn else {
                    return;
                };
                let view = self.ensure_turn(turn.clone());
                view.state = TurnState::Finished {
                    completion: completion_of(stop_reason),
                };
            }
            ConversationEvent::RunFailed { turn, message } => {
                let Some(turn) = turn else {
                    return;
                };
                let view = self.ensure_turn(turn.clone());
                view.state = TurnState::Finished {
                    completion: TurnCompletion::Failed {
                        reason: message.clone(),
                    },
                };
            }
            ConversationEvent::PermissionRequested { request_id, .. } => {
                self.open_interactions
                    .insert(request_id.clone(), OpenInteraction::Permission);
            }
            ConversationEvent::QuestionsAsked { question_id, .. } => {
                self.open_interactions
                    .insert(question_id.clone(), OpenInteraction::Question);
            }
            ConversationEvent::PermissionResolved { request_id, .. }
            | ConversationEvent::QuestionsResolved {
                question_id: request_id,
                ..
            } => {
                self.open_interactions.remove(request_id);
            }
            // 方言事件与本投影还不会折的事件：计数，不丢弃。逐个变体类型化的
            // 迁移发生在 translate 层，每补一个这里就少一类。
            ConversationEvent::KapEvent { .. }
            | ConversationEvent::UnsupportedExternalEvent { .. } => {
                self.unparsed_events = self.unparsed_events.saturating_add(1);
            }
            ConversationEvent::LinkChanged { .. } => {}
        }
    }

    fn ensure_turn(&mut self, turn: TurnId) -> &mut TurnView {
        if !self.turns.contains_key(&turn) {
            self.turn_order.push(turn.clone());
        }

        self.turns.entry(turn.clone()).or_insert_with(|| TurnView {
            turn,
            state: TurnState::Admitted,
        })
    }
}

/// agent 报的停止原因 → 轮次终局。这一轮的状态机只认这三种收场。
fn completion_of(stop_reason: &str) -> TurnCompletion {
    match stop_reason {
        "completed" => TurnCompletion::Completed,
        "cancelled" => TurnCompletion::Cancelled,
        reason => TurnCompletion::Failed {
            reason: reason.to_owned(),
        },
    }
}

pub fn project(thread: &ThreadId, events: &[EventEnvelope]) -> ThreadView {
    let mut view = ThreadView::empty(thread.clone());

    for envelope in events {
        view.apply(envelope);
    }

    view
}
