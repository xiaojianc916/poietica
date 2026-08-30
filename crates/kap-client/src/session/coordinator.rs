//! 投递与对账的所有权：每条会话一个串行投递者，跳线程并发。

use std::collections::{HashMap, VecDeque};

use futures::StreamExt;
use futures::channel::{mpsc, oneshot};

use super::book::SessionBook;
use super::client::{PromptAttachment, PromptSkill};
use super::rest::submit_prompt;
use crate::error::Result;

pub(crate) struct PromptJob {
    pub(crate) text: String,
    pub(crate) attachments: Vec<PromptAttachment>,
    pub(crate) skills: Vec<PromptSkill>,
    pub(crate) idempotency: String,
    pub(crate) reply: oneshot::Sender<Result<String>>,
}

enum PromptOwnerMessage {
    Submit(PromptJob),
    TurnEnded,
}

struct PromptOwner {
    messages: mpsc::UnboundedSender<PromptOwnerMessage>,
    task: tokio::task::JoinHandle<()>,
}

impl PromptOwner {
    fn spawn(
        session_id: String,
        http: reqwest::Client,
        base_url: String,
        book: SessionBook,
    ) -> Self {
        let (messages, mut incoming) = mpsc::unbounded();
        let task = tokio::spawn(async move {
            let mut pending = VecDeque::<PromptJob>::new();
            let mut active = false;

            while let Some(message) = incoming.next().await {
                match message {
                    PromptOwnerMessage::Submit(job) => pending.push_back(job),
                    PromptOwnerMessage::TurnEnded => active = false,
                }

                while !active {
                    let Some(job) = pending.pop_front() else {
                        break;
                    };
                    let result = submit_prompt(
                        &http,
                        &base_url,
                        &session_id,
                        &job.text,
                        &job.attachments,
                        &job.skills,
                        &job.idempotency,
                    )
                    .await;
                    active = result.is_ok();
                    if let Err(error) = &result
                        && let Err(closing) = book.fail_turn(&session_id, &error.to_string())
                    {
                        log::error!("could not close a rejected admission: {closing}");
                    }
                    let _sent = job.reply.send(result);
                }
            }
        });
        Self { messages, task }
    }

    fn send(&self, message: PromptOwnerMessage) {
        if self.messages.unbounded_send(message).is_err() {
            log::error!("prompt owner stopped unexpectedly");
        }
    }
}

impl Drop for PromptOwner {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub(crate) struct PromptCoordinator {
    owners: HashMap<String, PromptOwner>,
    http: reqwest::Client,
    base_url: String,
    book: SessionBook,
}

impl PromptCoordinator {
    pub(crate) fn new(http: reqwest::Client, base_url: String, book: SessionBook) -> Self {
        Self {
            owners: HashMap::new(),
            http,
            base_url,
            book,
        }
    }

    pub(crate) fn submit(&mut self, session_id: &str, job: PromptJob) {
        self.owners
            .entry(session_id.to_owned())
            .or_insert_with(|| {
                PromptOwner::spawn(
                    session_id.to_owned(),
                    self.http.clone(),
                    self.base_url.clone(),
                    self.book.clone(),
                )
            })
            .send(PromptOwnerMessage::Submit(job));
    }

    /// 这条会话没了，它的排队者跟着走：队列的事实在 agent 那侧，本地留一个没有
    /// 对端的排队者只会攒住那几个没人来取的答复。
    pub(crate) fn forget(&mut self, session_id: &str) {
        let _stopped = self.owners.remove(session_id);
    }

    pub(crate) fn turn_ended(&self, session_id: &str) {
        if let Some(owner) = self.owners.get(session_id) {
            owner.send(PromptOwnerMessage::TurnEnded);
        }
    }
}
