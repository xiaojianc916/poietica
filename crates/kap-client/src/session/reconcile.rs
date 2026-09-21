//! 审批与提问的对账：一条会话一个后台任务，WS 循环只投递意图，REST 调用与帧记账都在任务里。

use std::collections::HashSet;

use futures::channel::mpsc;
use futures::{FutureExt, StreamExt};
use serde_json::{Value, json};

use super::book::SessionBook;
use super::rest::session_snapshot;
use super::tasks::SessionTasks;
use crate::generated::rest::{
    ResolveApprovalRequestDecisionEnum, ResolveApprovalRequestScopeEnum,
    ResolveApprovalRequestStruct, routes,
};
use crate::http::{get, post};
use crate::interaction::desk::{PermissionDesk, QuestionDesk};
use crate::interaction::permission::Decision;
use crate::interaction::question::{QuestionGroup, QuestionOutcome};

#[derive(Clone)]
enum ReconcileMessage {
    Poll,
    RefreshQuestions,
    Reset,
    QuestionRequested(Value),
}

#[derive(Debug, Default, Eq, PartialEq)]
struct ReconcileBatch {
    poll: bool,
    refresh_questions: bool,
    reset: bool,
    questions: Vec<Value>,
}

impl ReconcileBatch {
    fn push(&mut self, message: ReconcileMessage) {
        match message {
            ReconcileMessage::Poll => self.poll = true,
            ReconcileMessage::RefreshQuestions => self.refresh_questions = true,
            ReconcileMessage::Reset => {
                self.reset = true;
                self.poll = false;
                self.refresh_questions = false;
                self.questions.clear();
            }
            ReconcileMessage::QuestionRequested(question) => self.questions.push(question),
        }
    }
}

#[derive(Default)]
struct ReconcileState {
    pending_approvals: HashSet<String>,
    pending_questions: HashSet<String>,
}

impl ReconcileState {
    fn reset(&mut self, desk: &PermissionDesk, questions: &QuestionDesk) {
        let outstanding = self.pending_approvals.drain().collect::<Vec<_>>();
        let unanswered = self.pending_questions.drain().collect::<Vec<_>>();

        desk.abandon(&outstanding);
        questions.abandon(&unanswered);
    }
}

pub(super) struct ReconcileOwner {
    messages: mpsc::UnboundedSender<ReconcileMessage>,
    task: tokio::task::JoinHandle<()>,
}

impl ReconcileOwner {
    pub(super) fn spawn(
        session_id: String,
        http: reqwest::Client,
        base_url: String,
        book: SessionBook,
        desk: PermissionDesk,
        questions: QuestionDesk,
        tasks: &SessionTasks,
    ) -> Self {
        let (messages, mut incoming) = mpsc::unbounded();
        let background = tasks.clone();
        let task = tasks.spawn(async move {
            let mut state = ReconcileState::default();

            while let Some(first) = incoming.next().await {
                let mut batch = ReconcileBatch::default();
                batch.push(first);

                while let Some(Some(message)) = incoming.next().now_or_never() {
                    batch.push(message);
                }

                if batch.reset {
                    state.reset(&desk, &questions);
                }

                if batch.refresh_questions {
                    match session_snapshot(&http, &base_url, &session_id).await {
                        Ok((_cursor, snapshot)) => {
                            batch.questions.extend(snapshot_questions(&snapshot));
                        }
                        Err(error) => {
                            log::error!(
                                "could not refresh pending questions after subscription: {error}"
                            );
                        }
                    }
                }

                for question in &batch.questions {
                    record_question_request(
                        &http,
                        &base_url,
                        &session_id,
                        &mut state.pending_questions,
                        &book,
                        &questions,
                        question,
                        &background,
                    );
                }

                if batch.poll {
                    fetch_and_record_approvals(
                        &http,
                        &base_url,
                        &session_id,
                        &mut state.pending_approvals,
                        &book,
                        &desk,
                        &background,
                    )
                    .await;
                }
            }

            state.reset(&desk, &questions);
        });

        Self { messages, task }
    }

    pub(super) fn poll(&self) {
        self.send(ReconcileMessage::Poll);
    }

    pub(super) fn refresh_questions(&self) {
        self.send(ReconcileMessage::RefreshQuestions);
    }

    pub(super) fn reset(&self) {
        self.send(ReconcileMessage::Reset);
    }

    pub(super) fn question_requested(&self, question: Value) {
        self.send(ReconcileMessage::QuestionRequested(question));
    }

    fn send(&self, message: ReconcileMessage) {
        if self.messages.unbounded_send(message).is_err() {
            log::warn!("session reconciliation owner stopped unexpectedly");
        }
    }
}

impl Drop for ReconcileOwner {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// status=pending 是必填 query（rest-approval.ts 的 listPendingApprovalsQuerySchema），缺了回 40001。
async fn fetch_and_record_approvals(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
    pending: &mut HashSet<String>,
    book: &SessionBook,
    desk: &PermissionDesk,
    tasks: &SessionTasks,
) {
    let url = routes::list_approvals(base_url, session_id).map(|mut url| {
        url.query_pairs_mut().append_pair("status", "pending");
        url
    });

    let data = match get(http, url).await {
        Ok(data) => data,
        Err(error) => {
            log::warn!("could not list the pending approvals: {error}");
            return;
        }
    };

    let items = data
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    for item in items {
        let Some(approval_id) = item
            .get("approval_id")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            continue;
        };

        if pending.contains(&approval_id) {
            continue;
        }

        if let Ok(Some(slot)) = book.slot(session_id) {
            slot.record(|recorder| {
                recorder.record_permission_requested_kap(
                    &approval_id,
                    item.get("tool_call_id")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                    item.get("tool_name").and_then(Value::as_str).unwrap_or(""),
                    &item,
                );
            });
        }

        let Ok(answer_rx) = desk.wait_kap(&approval_id) else {
            continue;
        };

        let _inserted = pending.insert(approval_id.clone());

        let http2 = http.clone();
        let base2 = base_url.to_owned();
        let sid = session_id.to_owned();
        let book2 = book.clone();

        tasks.spawn(async move {
            let Ok(response) = answer_rx.await else {
                return;
            };

            let answer = ResolveApprovalRequestStruct {
                decision: match response.decision {
                    Decision::Approved { .. } => ResolveApprovalRequestDecisionEnum::Approved,
                    Decision::Rejected => ResolveApprovalRequestDecisionEnum::Rejected,
                    Decision::Cancelled => ResolveApprovalRequestDecisionEnum::Cancelled,
                },
                scope: response
                    .decision
                    .scope()
                    .map(|_| ResolveApprovalRequestScopeEnum::Session),
                feedback: response.feedback.clone(),
                selected_label: response.selected_label.clone(),
            };

            let url = routes::resolve_approval(&base2, &sid, &approval_id);

            if let Err(error) = post(&http2, url, &answer).await {
                log::warn!("could not deliver the approval answer: {error}");
            }

            if let Ok(Some(slot)) = book2.slot(&sid) {
                slot.record(|recorder| {
                    recorder.record_permission_resolved_kap(&approval_id, response);
                });
            }
        });
    }
}

/// 官方用 40909 宣告撤下成功（routes/questions.ts 的 dismiss 分支）：不按码判，成功撤下会被记成失败。
const QUESTION_DISMISSED: i64 = 40909;

async fn settle_question(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
    question_id: &str,
    outcome: &QuestionOutcome,
) -> Result<(), String> {
    let (url, body) = match outcome {
        QuestionOutcome::Answered(response) => (
            routes::answer_question(base_url, session_id, question_id),
            response.on_wire(),
        ),
        QuestionOutcome::Dismissed => (
            routes::dismiss_question(base_url, session_id, &format!("{question_id}:dismiss")),
            json!({}),
        ),
    };

    match post(http, url, &body).await {
        Ok(_accepted) => Ok(()),
        Err(crate::error::KapError::Envelope { code, .. })
            if code == QUESTION_DISMISSED && matches!(outcome, QuestionOutcome::Dismissed) =>
        {
            Ok(())
        }
        Err(error) => Err(error.to_string()),
    }
}

fn snapshot_questions(snapshot: &Value) -> Vec<Value> {
    snapshot
        .get("pending_questions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn record_question_request(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
    pending: &mut HashSet<String>,
    book: &SessionBook,
    desk: &QuestionDesk,
    item: &Value,
    tasks: &SessionTasks,
) {
    let Some(group) = QuestionGroup::from_wire(item) else {
        let Some(question_id) = item.get("question_id").and_then(Value::as_str) else {
            log::error!("kap listed a pending question without an id: {item}");
            return;
        };

        log::error!("a pending question group does not fit the contract: {item}");

        let http2 = http.clone();
        let base2 = base_url.to_owned();
        let sid = session_id.to_owned();
        let qid = question_id.to_owned();

        tasks.spawn(async move {
            if let Err(error) =
                settle_question(&http2, &base2, &sid, &qid, &QuestionOutcome::Dismissed).await
            {
                log::warn!("could not dismiss an unreadable question group: {error}");
            }
        });

        return;
    };

    if pending.contains(&group.question_id) {
        return;
    }

    if let Ok(Some(slot)) = book.slot(session_id) {
        slot.record(|recorder| recorder.record_questions_asked(&group));
    }

    let Ok(answer_rx) = desk.wait(group.clone()) else {
        return;
    };

    let _inserted = pending.insert(group.question_id.clone());

    let http2 = http.clone();
    let base2 = base_url.to_owned();
    let sid = session_id.to_owned();
    let book2 = book.clone();

    tasks.spawn(async move {
        let Ok(outcome) = answer_rx.await else {
            return;
        };

        let delivered =
            match settle_question(&http2, &base2, &sid, &group.question_id, &outcome).await {
                Ok(()) => true,
                Err(error) => {
                    log::warn!("could not deliver the question answer: {error}");
                    false
                }
            };

        if let Ok(Some(slot)) = book2.slot(&sid) {
            slot.record(|recorder| {
                recorder.record_questions_resolved(&group, &outcome, delivered);
            });
        }
    });
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        reason = "a test proves itself by panicking, so a failed step must fail the test"
    )]

    use super::*;

    #[test]
    fn reconciliation_batch_preserves_reset_order() {
        let mut batch = ReconcileBatch::default();
        batch.push(ReconcileMessage::Poll);
        batch.push(ReconcileMessage::RefreshQuestions);
        batch.push(ReconcileMessage::Reset);

        assert_eq!(
            batch,
            ReconcileBatch {
                poll: false,
                refresh_questions: false,
                reset: true,
                questions: Vec::new(),
            }
        );

        batch.push(ReconcileMessage::RefreshQuestions);
        batch.push(ReconcileMessage::QuestionRequested(
            json!({ "question_id": "q1" }),
        ));
        batch.push(ReconcileMessage::Poll);

        assert_eq!(
            batch,
            ReconcileBatch {
                poll: true,
                refresh_questions: true,
                reset: true,
                questions: vec![json!({ "question_id": "q1" })],
            }
        );
    }

    #[test]
    fn snapshot_is_the_recovery_source_for_pending_questions() {
        let snapshot = json!({
            "pending_questions": [
                { "question_id": "q1" },
                { "question_id": "q2" }
            ]
        });

        assert_eq!(
            snapshot_questions(&snapshot),
            vec![
                json!({ "question_id": "q1" }),
                json!({ "question_id": "q2" })
            ]
        );
        assert!(snapshot_questions(&json!({})).is_empty());
    }
}
