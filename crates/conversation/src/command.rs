use crate::error::DomainFailure;
use crate::event::ConversationEvent;
use crate::ports::{ConversationLedger, PromptDelivery};
use crate::turn::AdmissionDecision;

pub struct Conversation<'a> {
    ledger: &'a dyn ConversationLedger,
}

impl core::fmt::Debug for Conversation<'_> {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("Conversation")
            .finish_non_exhaustive()
    }
}

impl<'a> Conversation<'a> {
    pub fn new(ledger: &'a dyn ConversationLedger) -> Self {
        Self { ledger }
    }

    pub fn admit(&self, delivery: &PromptDelivery) -> Result<AdmissionDecision, DomainFailure> {
        let decision = self.ledger.admit(&delivery.admission)?;
        if decision != AdmissionDecision::AlreadyAdmitted {
            self.ledger.append(
                &delivery.admission.thread,
                &delivery.session,
                &[ConversationEvent::TurnAdmitted {
                    turn: delivery.admission.turn.clone(),
                }],
            )?;
        }
        Ok(decision)
    }
}
