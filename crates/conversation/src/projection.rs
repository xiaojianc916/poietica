use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::event::{ConversationEvent, EventEnvelope};
use crate::identity::{Seq, ThreadId, TurnId};
use crate::interaction::{InteractionId, InteractionRequest};
use crate::tool_call::{ToolCallId, ToolOutcome};
use crate::turn::state_machine::TurnState;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolView {
    pub name: String,
    pub outcome: Option<ToolOutcome>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnView {
    pub turn: TurnId,
    pub state: TurnState,
    pub text: String,
    pub reasoning: String,
    pub tools: BTreeMap<ToolCallId, ToolView>,
    pub open_interactions: BTreeMap<InteractionId, InteractionRequest>,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadView {
    pub thread: ThreadId,
    pub last_seq: Seq,
    pub turn_order: Vec<TurnId>,
    pub turns: BTreeMap<TurnId, TurnView>,
    /// pin 住的契约不认识的事件数；缺口可见才能被补上。
    pub unsupported_events: u64,
}

impl ThreadView {
    pub fn empty(thread: ThreadId) -> Self {
        Self {
            thread,
            last_seq: Seq::NONE,
            turn_order: Vec::new(),
            turns: BTreeMap::new(),
            unsupported_events: 0,
        }
    }

    /// 实时流与冷重放走的是同一个函数，所以两边不会各说各话。
    pub fn apply(&mut self, envelope: &EventEnvelope) {
        self.last_seq = envelope.seq;

        let Some(turn) = envelope.event.turn() else {
            self.unsupported_events = self.unsupported_events.saturating_add(1);
            return;
        };

        let view = self.ensure_turn(turn.clone());

        match &envelope.event {
            ConversationEvent::TurnAdmitted { .. } => view.state = TurnState::Admitted,
            ConversationEvent::AssistantText { text, .. } => {
                view.state = TurnState::Streaming;
                view.text.push_str(text);
            }
            ConversationEvent::Reasoning { text, .. } => {
                view.state = TurnState::Streaming;
                view.reasoning.push_str(text);
            }
            ConversationEvent::ToolCallStarted { call, name, .. } => {
                view.state = TurnState::Streaming;
                view.tools.insert(
                    call.clone(),
                    ToolView {
                        name: name.clone(),
                        outcome: None,
                    },
                );
            }
            ConversationEvent::ToolCallFinished { call, outcome, .. } => {
                if let Some(tool) = view.tools.get_mut(call) {
                    tool.outcome = Some(*outcome);
                }
            }
            ConversationEvent::InteractionRequested { request, .. } => {
                view.state = TurnState::AwaitingInteraction;
                view.open_interactions
                    .insert(request.id().clone(), request.clone());
            }
            ConversationEvent::InteractionResolved { interaction, .. } => {
                view.open_interactions.remove(interaction);
                view.state = TurnState::Streaming;
            }
            ConversationEvent::UsageReported {
                input_tokens,
                output_tokens,
                ..
            } => {
                view.input_tokens = view.input_tokens.saturating_add(*input_tokens);
                view.output_tokens = view.output_tokens.saturating_add(*output_tokens);
            }
            ConversationEvent::TurnFinished { completion, .. } => {
                view.open_interactions.clear();
                view.state = TurnState::Finished {
                    completion: completion.clone(),
                };
            }
            ConversationEvent::UnsupportedExternalEvent { .. } => {}
        }
    }

    fn ensure_turn(&mut self, turn: TurnId) -> &mut TurnView {
        if !self.turns.contains_key(&turn) {
            self.turn_order.push(turn.clone());
        }

        self.turns.entry(turn.clone()).or_insert_with(|| TurnView {
            turn,
            state: TurnState::Admitted,
            text: String::new(),
            reasoning: String::new(),
            tools: BTreeMap::new(),
            open_interactions: BTreeMap::new(),
            input_tokens: 0,
            output_tokens: 0,
        })
    }
}

pub fn project(thread: &ThreadId, events: &[EventEnvelope]) -> ThreadView {
    let mut view = ThreadView::empty(thread.clone());

    for envelope in events {
        view.apply(envelope);
    }

    view
}
