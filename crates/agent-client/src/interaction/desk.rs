use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use futures::channel::oneshot;

use super::permission::ApprovalResponse;
use super::question::{QuestionGroup, QuestionOutcome, QuestionResponse};
use crate::error::{AgentError, Result};

const UNKNOWN_REQUEST: &str = "that permission request is not outstanding";
const HANDLER_GONE: &str = "the agent stopped waiting for that permission request";

#[derive(Debug)]
struct Waiting {
    answer: oneshot::Sender<ApprovalResponse>,
}

#[derive(Clone, Debug, Default)]
pub struct PermissionDesk {
    outstanding: Arc<Mutex<HashMap<String, Waiting>>>,
}

impl PermissionDesk {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn wait(&self, request_id: &str) -> Result<oneshot::Receiver<ApprovalResponse>> {
        let (answer, waiting) = oneshot::channel();

        let _replaced = self
            .lock()?
            .insert(request_id.to_owned(), Waiting { answer });

        Ok(waiting)
    }

    pub fn answer(&self, request_id: &str, response: ApprovalResponse) -> Result<()> {
        let Some(waiting) = self.lock()?.remove(request_id) else {
            return Err(refused(UNKNOWN_REQUEST));
        };

        waiting
            .answer
            .send(response)
            .map_err(|_gone| refused(HANDLER_GONE))
    }

    pub fn clear(&self) {
        if let Ok(mut outstanding) = self.outstanding.lock() {
            outstanding.clear();
        }
    }

    #[must_use]
    pub fn waiting(&self) -> usize {
        self.outstanding
            .lock()
            .map_or(0, |outstanding| outstanding.len())
    }

    fn lock(&self) -> Result<MutexGuard<'_, HashMap<String, Waiting>>> {
        self.outstanding
            .lock()
            .map_err(|_poisoned| AgentError::Poisoned)
    }
}

fn refused(message: &str) -> AgentError {
    AgentError::Permission {
        message: message.to_owned(),
    }
}

const UNKNOWN_GROUP: &str = "that question group is not outstanding";
const ASKER_GONE: &str = "the agent stopped waiting for that question group";

#[derive(Clone, Debug, Default)]
pub struct QuestionDesk {
    outstanding: Arc<Mutex<HashMap<String, Asked>>>,
}

#[derive(Debug)]
struct Asked {
    group: QuestionGroup,
    answer: oneshot::Sender<QuestionOutcome>,
}

impl QuestionDesk {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn wait(&self, group: QuestionGroup) -> Result<oneshot::Receiver<QuestionOutcome>> {
        let (answer, waiting) = oneshot::channel();
        let question_id = group.question_id.clone();

        let _replaced = self.lock()?.insert(question_id, Asked { group, answer });

        Ok(waiting)
    }

    pub fn answer(&self, question_id: &str, response: QuestionResponse) -> Result<()> {
        let mut outstanding = self.lock()?;

        let Some(asked) = outstanding.get(question_id) else {
            return Err(super::question::refused(UNKNOWN_GROUP));
        };

        // 先验再取：一个说不通的答复不该把一组还在正当等着人回答的题毁掉。
        response.checked_against(&asked.group)?;

        let Some(asked) = outstanding.remove(question_id) else {
            return Err(super::question::refused(UNKNOWN_GROUP));
        };

        asked
            .answer
            .send(QuestionOutcome::Answered(response))
            .map_err(|_gone| super::question::refused(ASKER_GONE))
    }

    /// 与「每一题都选跳过」不是一件事：撤下是这一组作罢 —— 答复空着回到桥那边，
    /// 桥把它当「没有人答」，上游据此取消这次提问。
    pub fn dismiss(&self, question_id: &str) -> Result<()> {
        let Some(asked) = self.lock()?.remove(question_id) else {
            return Err(super::question::refused(UNKNOWN_GROUP));
        };

        asked
            .answer
            .send(QuestionOutcome::Dismissed)
            .map_err(|_gone| super::question::refused(ASKER_GONE))
    }

    pub fn clear(&self) {
        if let Ok(mut outstanding) = self.lock() {
            outstanding.clear();
        }
    }

    fn lock(&self) -> Result<MutexGuard<'_, HashMap<String, Asked>>> {
        self.outstanding
            .lock()
            .map_err(|_poisoned| AgentError::Poisoned)
    }
}
