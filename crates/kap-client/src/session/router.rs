//! 事件路由：WS 事件信封 → 帧 → 会话账，以及对账（审批与提问）的拉取。

use std::collections::{HashMap, HashSet};

use futures::channel::mpsc;
use futures::{FutureExt, StreamExt};
use serde_json::{Value, json};

use super::book::SessionBook;
use super::coordinator::{PromptCoordinator, PromptJob};
use super::rest::{get, get_selectors, post, session_snapshot};
use super::{Cursor, SessionEvent, SessionUsageSnapshot};
use crate::connection::handshake::subscribe;
use crate::connection::socket::WsSink;
use crate::frame::kap_event;
use crate::generated::rest::{
    ResolveApprovalRequestDecisionEnum, ResolveApprovalRequestScopeEnum,
    ResolveApprovalRequestStruct,
};
use crate::interaction::desk::{PermissionDesk, QuestionDesk};
use crate::interaction::permission::Decision;
use crate::interaction::question::{QuestionGroup, QuestionOutcome};

#[derive(Clone, Copy)]
enum ReconcileMessage {
    Poll,
    Reset,
}

#[derive(Debug, Default, Eq, PartialEq)]
struct ReconcileBatch {
    poll: bool,
    reset: bool,
}

impl ReconcileBatch {
    fn push(&mut self, message: ReconcileMessage) {
        match message {
            ReconcileMessage::Poll => self.poll = true,
            ReconcileMessage::Reset => {
                self.reset = true;
                self.poll = false;
            }
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

/// A session owns one reconciliation task. The WebSocket loop only enqueues intent.
struct ReconcileOwner {
    messages: mpsc::UnboundedSender<ReconcileMessage>,
    task: tokio::task::JoinHandle<()>,
}

impl ReconcileOwner {
    fn spawn(
        session_id: String,
        http: reqwest::Client,
        base_url: String,
        book: SessionBook,
        desk: PermissionDesk,
        questions: QuestionDesk,
    ) -> Self {
        let (messages, mut incoming) = mpsc::unbounded();
        let task = tokio::spawn(async move {
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

                if batch.poll {
                    let ReconcileState {
                        pending_approvals,
                        pending_questions,
                    } = &mut state;

                    futures::join!(
                        fetch_and_record_approvals(
                            &http,
                            &base_url,
                            &session_id,
                            pending_approvals,
                            &book,
                            &desk,
                        ),
                        fetch_and_record_questions(
                            &http,
                            &base_url,
                            &session_id,
                            pending_questions,
                            &book,
                            &questions,
                        ),
                    );
                }
            }

            state.reset(&desk, &questions);
        });

        Self { messages, task }
    }

    fn poll(&self) {
        self.send(ReconcileMessage::Poll);
    }

    fn reset(&self) {
        self.send(ReconcileMessage::Reset);
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

/// 有人在等人这一侧的答复吗。
///
/// 会话状态那一帧是唯一同时报两条队列的地方（kap-server 的
/// transport/ws/v1/events.ts：status 取 awaiting_approval / awaiting_question）。
/// agent.status.updated 的 phase 报不出提问 —— services/legacyStatus/legacyStatus.ts
/// 的 AgentPhase 只有 idle / running / streaming / tool_call / retrying /
/// awaiting_approval / interrupted / ended，所以它只当审批的信号。
fn awaits_person(event_type: &str, payload: &Value) -> bool {
    match event_type {
        "event.session.status_changed" => matches!(
            payload.get("status").and_then(Value::as_str),
            Some("awaiting_approval" | "awaiting_question")
        ),
        "agent.status.updated" => {
            payload
                .get("phase")
                .and_then(|phase| phase.get("kind"))
                .and_then(Value::as_str)
                == Some("awaiting_approval")
        }
        _ => false,
    }
}

pub(crate) struct EventRouter {
    owners: HashMap<String, ReconcileOwner>,
    book: SessionBook,
    desk: PermissionDesk,
    questions: QuestionDesk,
    events_tx: mpsc::UnboundedSender<SessionEvent>,
    http: reqwest::Client,
    base_url: String,
    cursors: HashMap<String, Cursor>,
    prompts: PromptCoordinator,
    ws: WsSink,
    recoveries: HashMap<String, tokio::task::JoinHandle<()>>,
}

impl EventRouter {
    pub(crate) fn new(
        book: SessionBook,
        desk: PermissionDesk,
        questions: QuestionDesk,
        events_tx: mpsc::UnboundedSender<SessionEvent>,
        http: reqwest::Client,
        base_url: String,
        ws: WsSink,
    ) -> Self {
        let prompts = PromptCoordinator::new(http.clone(), base_url.clone(), book.clone());
        Self {
            owners: HashMap::new(),
            book,
            desk,
            questions,
            events_tx,
            http,
            base_url,
            cursors: HashMap::new(),
            prompts,
            ws,
            recoveries: HashMap::new(),
        }
    }

    pub(crate) fn cursors(&self) -> &HashMap<String, Cursor> {
        &self.cursors
    }

    pub(crate) fn submit(&mut self, session_id: &str, job: PromptJob) {
        self.prompts.submit(session_id, job);
    }

    /// 这条会话在 server 侧没有了：在飞的那一轮判死，读点作废，本地不再留任何
    /// 与它有关的所有权。链路与其余会话不受影响 —— 全仓只有这一处这条策略。
    pub(crate) fn forget(&mut self, session_id: &str, reason: &str) {
        log::warn!("kap no longer serves {session_id}: {reason}");

        if let Err(error) = self.book.fail_turn(session_id, reason) {
            log::error!("could not close the turn of a forgotten session: {error}");
        }

        let _dropped = self.cursors.remove(session_id);
        let _stopped = self.owners.remove(session_id);
        self.prompts.forget(session_id);

        let _sent = self.events_tx.unbounded_send(SessionEvent::CursorLost {
            session_id: session_id.to_owned(),
        });

        if let Err(error) = self.book.close(session_id) {
            log::error!("could not drop a forgotten session: {error}");
        }
    }

    pub(crate) fn handle(&mut self, envelope: &Value) {
        // 事件帧的 type 就是事件自己的 type（turn.ended / assistant.delta / …），
        // 不是字符串 "session_event"：wsEventEnvelopeSchema 里 type 是 z.string()，
        // sessionEventOperation 的 'session_event' 只是操作目录里那一条的名字。
        //
        // 判据：同时带 session_id、seq 和一个自带 type 的载荷，且两个 type 相等。
        // 控制帧与系统帧就此排除 —— 系统 error 帧的载荷是 { code, msg, fatal }，
        // 既没有 type 也没有 seq，不会被当成 agent 的 error 事件收进来。
        let kind = envelope.get("type").and_then(Value::as_str).unwrap_or("");

        // 订阅失败不写在 code 上：ack 永远回 0，落选的会话在载荷的 not_found 里。
        // 异步订阅（新开 / 装载 / 分叉）的 ack 只到得了这里，落选按会话收摊。
        if kind == "ack"
            && let Some(missing) = envelope
                .get("payload")
                .and_then(|payload| payload.get("not_found"))
                .and_then(Value::as_array)
                .map(|ids| {
                    ids.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect::<Vec<String>>()
                })
            && !missing.is_empty()
        {
            for refused in missing {
                self.forget(&refused, "the server refused to subscribe this session");
            }

            return;
        }

        let Self {
            owners,
            book,
            desk,
            questions,
            events_tx,
            http,
            base_url,
            cursors,
            prompts,
            ws: _,
            recoveries: _,
        } = self;

        // kap 说这条会话的事件流断了（reason 枚举 buffer_overflow / session_recreated /
        // epoch_changed，见 contracts/kap/asyncapi.json 的 resync_required 载荷）：断点
        // 之后的帧不会再来，这一轮的经过补不齐。判死它 —— 补不回来的东西不该装作还在路上。
        if kind == "resync_required" {
            let Some(cut) = envelope
                .get("payload")
                .and_then(|payload| payload.get("session_id"))
                .or_else(|| envelope.get("session_id"))
                .and_then(Value::as_str)
                .filter(|named| !named.is_empty())
            else {
                log::warn!("kap asked for a resync without naming a session");

                return;
            };

            let reason = envelope
                .get("payload")
                .and_then(|payload| payload.get("reason"))
                .and_then(Value::as_str)
                .unwrap_or("unknown");

            log::warn!("kap cut the stream of {cut}: {reason}");

            if self
                .recoveries
                .get(cut)
                .is_some_and(|task| !task.is_finished())
            {
                return;
            }
            if let Some(task) = self.recoveries.remove(cut) {
                task.abort();
            }
            let http = self.http.clone();
            let base = self.base_url.clone();
            let book = self.book.clone();
            let ws = std::sync::Arc::clone(&self.ws);
            let events = self.events_tx.clone();
            let sid = cut.to_owned();
            let owner = self.owners.entry(sid.clone()).or_insert_with(|| {
                ReconcileOwner::spawn(
                    sid.clone(),
                    http.clone(),
                    base.clone(),
                    book.clone(),
                    self.desk.clone(),
                    self.questions.clone(),
                )
            });
            owner.reset();
            owner.poll();
            let task = tokio::spawn(async move {
                match session_snapshot(&http, &base, &sid).await {
                    Ok((cursor, snapshot)) => {
                        if let Ok(Some(slot)) = book.slot(&sid) {
                            slot.record(|recorder| recorder.record_session_recovered(snapshot));
                        }
                        let _ = events.unbounded_send(SessionEvent::Cursor {
                            session_id: sid.clone(),
                            cursor: cursor.clone(),
                        });
                        if let Err(error) = subscribe(&ws, &sid, Some(&cursor)).await {
                            let _ = book
                                .fail_turn(&sid, &format!("snapshot resubscribe failed: {error}"));
                        }
                    }
                    Err(error) => {
                        let _ = book.fail_turn(&sid, &format!("snapshot recovery failed: {error}"));
                    }
                }
            });
            self.recoveries.insert(cut.to_owned(), task);
            return;
        }

        let Some(session_id) = envelope.get("session_id").and_then(Value::as_str) else {
            return;
        };

        // 位置由 kap 签发（信封上的 seq，跨守护进程重启有效）。此前它只被用来判一下
        // 「这是不是一帧事件」随后丢掉，于是重新订阅时说不出从哪儿接着发。
        let Some(seq) = envelope.get("seq").and_then(Value::as_i64) else {
            return;
        };

        let Some(payload) = envelope.get("payload") else {
            return;
        };

        let event_type = payload.get("type").and_then(Value::as_str).unwrap_or("");

        if event_type != kind {
            return;
        }

        /* 链路读到哪儿了，按帧记。它必须是「真的消费过的最后一帧」：拿轮终那个落库
        读点去续订，会让 kap 重发本轮已经记下的帧。 */
        let _moved = cursors.insert(
            session_id.to_owned(),
            Cursor {
                seq,
                epoch: envelope
                    .get("epoch")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            },
        );

        // 认下来的每一帧事件都成帧进录制器 —— 判据在上面，这里不再问第二遍。
        if let Ok(Some(slot)) = book.slot(session_id) {
            let frame = kap_event(payload.clone());
            slot.record(|recorder| recorder.record_frame(frame));
        }

        /* 有人在等人这一侧的答复。清单的权威在 REST，事件只是信号。 */
        if awaits_person(event_type, payload) {
            owners
                .entry(session_id.to_owned())
                .or_insert_with(|| {
                    ReconcileOwner::spawn(
                        session_id.to_owned(),
                        http.clone(),
                        base_url.to_owned(),
                        book.clone(),
                        desk.clone(),
                        questions.clone(),
                    )
                })
                .poll();
        }

        match event_type {
            "event.session.work_changed" => {
                /* work_changed 是会话活动投影，不是轮终错误通道。busy=false 只说明聚合已
                空闲；正式结果由 main agent 的 turn.ended 携带。这里仅在聚合落定后推进
                durable cursor，让同轮稍后到达的 error 事件也包含在续订水位内。 */
                if payload.get("busy").and_then(Value::as_bool) == Some(false) {
                    let _sent = events_tx.unbounded_send(SessionEvent::Cursor {
                        session_id: session_id.to_owned(),
                        cursor: Cursor {
                            seq,
                            epoch: envelope
                                .get("epoch")
                                .and_then(Value::as_str)
                                .map(str::to_owned),
                        },
                    });
                }
            }

            "turn.ended" => {
                let is_main_turn = payload.get("agentId").and_then(Value::as_str) == Some("main");

                if is_main_turn {
                    let reason = payload
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or("invalid");
                    if let Some(owner) = owners.get(session_id) {
                        owner.reset();
                    }

                    let ended = match reason {
                        /* 这是状态终帧；用户可见错误来自前一帧 turn.ended.error。 */
                        "completed" | "cancelled" | "failed" | "blocked" => {
                            book.finish_turn(session_id, reason)
                        }
                        unknown => book.fail_turn(
                            session_id,
                            &format!("KAP turn.ended carried an unknown reason: {unknown}"),
                        ),
                    };

                    match ended {
                        Ok(_) => prompts.turn_ended(session_id),
                        Err(error) => {
                            log::error!("could not close the turn kap just ended: {error}");
                        }
                    }

                    /* 一轮落定，目标的轮数、用量与时长都变了：整表推一次。 */
                    let http2 = http.clone();
                    let base2 = base_url.to_owned();
                    let sid = session_id.to_owned();
                    let events2 = events_tx.clone();

                    tokio::spawn(async move {
                        let Ok((offered, goal)) = get_selectors(&http2, &base2, &sid).await else {
                            return;
                        };

                        let _sent = events2.unbounded_send(SessionEvent::Selectors {
                            session_id: sid,
                            controls: offered,
                            goal,
                        });
                    });
                }
            }

            "agent.status.updated" => {
                // 仪表值是 volatile 信号（不进帧日志）：到达即替换。同一帧还挂着这条
                // 会话累计的输入构成（usage.total，kap events-zod.ts），三格计数与读数
                // 在同一次取走 —— 这条协议知识全程只有这一处。
                if let (Some(used), Some(size)) = (
                    payload.get("contextTokens").and_then(Value::as_u64),
                    payload.get("maxContextTokens").and_then(Value::as_u64),
                ) {
                    let total = payload.get("usage").and_then(|usage| usage.get("total"));
                    let counter = |key: &str| {
                        total
                            .and_then(|t| t.get(key))
                            .and_then(Value::as_u64)
                            .unwrap_or(0)
                    };

                    let _sent = events_tx.unbounded_send(SessionEvent::Usage {
                        session_id: session_id.to_owned(),
                        usage: SessionUsageSnapshot {
                            used,
                            size,
                            input_other: counter("inputOther"),
                            input_cache_read: counter("inputCacheRead"),
                            input_cache_creation: counter("inputCacheCreation"),
                        },
                    });
                }
            }

            _ => {}
        }
    }
}

/// agent 报它卡在审批上时，把这条会话挂着的审批逐个请上桌。
///
/// status=pending 是必填 query（rest-approval.ts 的
/// listPendingApprovalsQuerySchema），不带它服务器回 40001。
async fn fetch_and_record_approvals(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
    pending: &mut HashSet<String>,
    book: &SessionBook,
    desk: &PermissionDesk,
) {
    let url = format!("{base_url}/sessions/{session_id}/approvals?status=pending");

    let data = match get(http, &url).await {
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

        // 同一个审批会随每一份 agent.status.updated 再报一次：桌上已经有了的
        // 不记第二帧、不等第二份答案。
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

        tokio::spawn(async move {
            // 发送端被丢掉只有一种情形：这一轮已经结束了（turn.ended 把它从桌上
            // 放掉了）。那时这不再是我们该回答的问题 —— 什么都不发。
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

            let url = format!("{base2}/sessions/{sid}/approvals/{approval_id}");

            if let Err(error) = post(&http2, &url, &answer).await {
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

/// 撤下成功时信封里的 code。
///
/// 官方用一个非零码宣告成功：撤下这一路回的是
/// { code: QUESTION_DISMISSED, data: { dismissed: true, dismissed_at } }
/// （routes/questions.ts 的 dismiss 分支；error-codes.ts 里它是 40909）。不按码
/// 判，每一次成功的撤下都会被记成一次失败。
const QUESTION_DISMISSED: i64 = 40909;

/// 把一组题的收场送回 kap。
///
/// 两个动作同一条路由，靠动作后缀分路：POST …/questions/{id} 是回答，
/// POST …/questions/{id}:dismiss 是撤下（routes/questions.ts 的 parseActionSuffix：
/// allowedActions 只有 dismiss，默认 resolve）。
///
/// 错误不带 KapError 出来 —— 这里只有一个调用者，它要的就是一句能写进日志与帧
/// 的话。
async fn settle_question(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
    question_id: &str,
    outcome: &QuestionOutcome,
) -> Result<(), String> {
    let (url, body) = match outcome {
        QuestionOutcome::Answered(response) => (
            format!("{base_url}/sessions/{session_id}/questions/{question_id}"),
            response.on_wire(),
        ),
        QuestionOutcome::Dismissed => (
            format!("{base_url}/sessions/{session_id}/questions/{question_id}:dismiss"),
            json!({}),
        ),
    };

    match post(http, &url, &body).await {
        Ok(_accepted) => Ok(()),
        Err(crate::error::KapError::Envelope { code, .. })
            if code == QUESTION_DISMISSED && matches!(outcome, QuestionOutcome::Dismissed) =>
        {
            Ok(())
        }
        Err(error) => Err(error.to_string()),
    }
}

/// agent 报它卡在人这一侧时，把这条会话挂着的题组逐个请上桌。
///
/// status=pending 是必填 query（rest-question.ts 的
/// listPendingQuestionsQuerySchema），不带它服务器回 40001。
async fn fetch_and_record_questions(
    http: &reqwest::Client,
    base_url: &str,
    session_id: &str,
    pending: &mut HashSet<String>,
    book: &SessionBook,
    desk: &QuestionDesk,
) {
    let url = format!("{base_url}/sessions/{session_id}/questions?status=pending");

    let data = match get(http, &url).await {
        Ok(data) => data,
        Err(error) => {
            log::warn!("could not list the pending questions: {error}");
            return;
        }
    };

    let items = data
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    for item in items {
        let Some(group) = QuestionGroup::from_wire(&item) else {
            /* 读不出的题组不能装作没来过：撤下它，agent 才不会在人这一侧死等到超时。 */
            let Some(question_id) = item.get("question_id").and_then(Value::as_str) else {
                log::error!("kap listed a pending question without an id: {item}");
                continue;
            };

            log::error!("a pending question group does not fit the contract: {item}");

            let http2 = http.clone();
            let base2 = base_url.to_owned();
            let sid = session_id.to_owned();
            let qid = question_id.to_owned();

            tokio::spawn(async move {
                if let Err(error) =
                    settle_question(&http2, &base2, &sid, &qid, &QuestionOutcome::Dismissed).await
                {
                    log::warn!("could not dismiss an unreadable question group: {error}");
                }
            });

            continue;
        };

        // 同一组题会随每一份 agent.status.updated 再报一次：桌上已经有了的不记
        // 第二帧、不等第二份答案。
        if pending.contains(&group.question_id) {
            continue;
        }

        if let Ok(Some(slot)) = book.slot(session_id) {
            slot.record(|recorder| recorder.record_questions_asked(&group));
        }

        let Ok(answer_rx) = desk.wait(group.clone()) else {
            continue;
        };

        let _inserted = pending.insert(group.question_id.clone());

        let http2 = http.clone();
        let base2 = base_url.to_owned();
        let sid = session_id.to_owned();
        let book2 = book.clone();

        tokio::spawn(async move {
            // 发送端被丢掉只有一种情形：这一轮已经结束了（turn.ended 把它从桌上
            // 放掉了）。那时这不再是我们该回答的问题 —— 什么都不发。
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
}

#[cfg(test)]
mod tests {
    // 与 tests/recorder.rs 顶上那一句同一条纪律、同一个理由（Cargo.toml lints
    // 注释）：测试里的 expect 是响亮失败，豁免只写在测试作用域，不靠根配置放开。
    #![allow(
        clippy::expect_used,
        reason = "a test proves itself by panicking, so a failed step must fail the test"
    )]

    use super::*;

    #[test]
    fn reconciliation_batch_preserves_reset_order() {
        let mut batch = ReconcileBatch::default();
        batch.push(ReconcileMessage::Poll);
        batch.push(ReconcileMessage::Poll);
        batch.push(ReconcileMessage::Reset);

        assert_eq!(
            batch,
            ReconcileBatch {
                poll: false,
                reset: true
            }
        );

        batch.push(ReconcileMessage::Poll);
        assert_eq!(
            batch,
            ReconcileBatch {
                poll: true,
                reset: true
            }
        );
    }
}
