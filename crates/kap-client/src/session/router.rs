//! 事件路由：WS 事件信封 → 帧 → 会话账；ack 的订阅屏障与 resync 的快照恢复。
//! 审批与提问的 REST 对账在 reconcile.rs，路由只向它投递意图。

use std::collections::HashMap;

use futures::channel::mpsc;
use serde_json::Value;

use super::book::SessionBook;
use super::reconcile::ReconcileOwner;
use super::rest::{get_selectors, session_snapshot};
use super::tasks::SessionTasks;
use super::{Cursor, SessionEvent, SessionUsageSnapshot};
use crate::connection::handshake::subscribe;
use crate::connection::socket::WsSink;
use crate::interaction::desk::{PermissionDesk, QuestionDesk};

pub(crate) struct EventRouter {
    owners: HashMap<String, ReconcileOwner>,
    book: SessionBook,
    desk: PermissionDesk,
    questions: QuestionDesk,
    events_tx: mpsc::UnboundedSender<SessionEvent>,
    http: reqwest::Client,
    base_url: String,
    cursors: HashMap<String, Cursor>,
    ws: WsSink,
    recoveries: HashMap<String, tokio::task::JoinHandle<()>>,
    tasks: SessionTasks,
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
        tasks: SessionTasks,
    ) -> Self {
        Self {
            owners: HashMap::new(),
            book,
            desk,
            questions,
            events_tx,
            http,
            base_url,
            cursors: HashMap::new(),
            ws,
            recoveries: HashMap::new(),
            tasks,
        }
    }

    pub(crate) fn cursors(&self) -> &HashMap<String, Cursor> {
        &self.cursors
    }

    /// 这条会话在 server 侧没有了：在飞的那一轮判死，读点作废，本地不再留任何
    /// 与它有关的所有权。链路与其余会话不受影响 —— 全仓只有这一处这条策略。
    pub(crate) fn forget(&mut self, session_id: &str, reason: &str) {
        /* debug 而非 warn：重连轮换里这是常态账目，判死后果（CursorLost +
        fail_turn）已显式上桌，warn 只会刷屏。 */
        log::debug!("kap no longer serves {session_id}: {reason}");

        if let Err(error) = self.book.fail_turn(session_id, reason) {
            log::error!("could not close the turn of a forgotten session: {error}");
        }

        let _dropped = self.cursors.remove(session_id);
        let _stopped = self.owners.remove(session_id);
        if let Some(task) = self.recoveries.remove(session_id) {
            task.abort();
        }

        let _sent = self.events_tx.unbounded_send(SessionEvent::CursorLost {
            session_id: session_id.to_owned(),
        });

        if let Err(error) = self.book.close(session_id) {
            log::error!("could not drop a forgotten session: {error}");
        }
    }

    pub(crate) fn handle(&mut self, envelope: &Value) {
        // 事件帧的 type 就是事件自己的 type（turn.ended / …），不是 "session_event"：
        // 那只是操作目录里那条的名字（wsEventEnvelopeSchema 里 type 是 z.string()）。
        // 判据：session_id + seq + 载荷自带同值 type，控制帧与系统帧就此排除 ——
        // 系统 error 帧的载荷 { code, msg, fatal } 既无 type 也无 seq，收不进来。
        let kind = envelope.get("type").and_then(Value::as_str).unwrap_or("");

        if matches!(kind, "event.config.changed" | "event.model_catalog.changed") {
            let _sent = self
                .events_tx
                .unbounded_send(SessionEvent::ModelCatalogChanged);
            return;
        }

        // An accepted subscription is the snapshot barrier: anything pending before it
        // is in the snapshot; anything after it arrives as a durable event.
        if kind == "ack" {
            let session_ids = |key: &str| {
                envelope
                    .get("payload")
                    .and_then(|payload| payload.get(key))
                    .and_then(Value::as_array)
                    .map(|ids| {
                        ids.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect::<Vec<String>>()
                    })
                    .unwrap_or_default()
            };

            for refused in session_ids("not_found") {
                self.forget(&refused, "the server refused to subscribe this session");
            }

            let http = self.http.clone();
            let base_url = self.base_url.clone();
            let book = self.book.clone();
            let desk = self.desk.clone();
            let questions = self.questions.clone();
            let tasks = self.tasks.clone();

            for session_id in session_ids("accepted") {
                self.owners
                    .entry(session_id.clone())
                    .or_insert_with(|| {
                        ReconcileOwner::spawn(
                            session_id,
                            http.clone(),
                            base_url.clone(),
                            book.clone(),
                            desk.clone(),
                            questions.clone(),
                            &tasks,
                        )
                    })
                    .refresh_questions();
            }

            return;
        }

        let Self {
            owners,
            tasks,
            book,
            desk,
            questions,
            events_tx,
            http,
            base_url,
            cursors: _,
            ws: _,
            recoveries: _,
        } = self;

        // 官方 transcript 通道（subscribe_v2 订的 per-agent 粒度流）：语义事件
        // 原样转交宿主，不在本地帧日志过账 —— 重放由 agent 自己的 transcript 承担。
        if matches!(kind, "transcript.reset" | "transcript.ops") {
            let session_id = envelope
                .get("session_id")
                .and_then(Value::as_str)
                .or_else(|| {
                    envelope
                        .pointer("/payload/session_id")
                        .and_then(Value::as_str)
                });
            if let Some(session_id) = session_id {
                let _sent = self.events_tx.unbounded_send(SessionEvent::Transcript {
                    session_id: session_id.to_owned(),
                    payload: envelope.clone(),
                });
            }
            return;
        }

        // kap 断流（reason 枚举见 contracts/kap/asyncapi.json 的 resync_required
        // 载荷）：断点后的帧不会再来，这一轮补不齐，判死它；transcript 通道同帧
        // 受累，转发 resync 让下游走全量刷新。
        if kind == "resync_required" {
            if let Some(session_id) =
                envelope
                    .get("session_id")
                    .and_then(Value::as_str)
                    .or_else(|| {
                        envelope
                            .pointer("/payload/session_id")
                            .and_then(Value::as_str)
                    })
            {
                let _sent = self.events_tx.unbounded_send(SessionEvent::Transcript {
                    session_id: session_id.to_owned(),
                    payload: envelope.clone(),
                });
            }
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
                    tasks,
                )
            });
            owner.reset();
            owner.poll();
            let task = tasks.spawn(async move {
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

        // 位置由 kap 签发（信封 seq，跨守护进程重启有效），续订按它接着发。
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

        let owner = || {
            ReconcileOwner::spawn(
                session_id.to_owned(),
                http.clone(),
                base_url.to_owned(),
                book.clone(),
                desk.clone(),
                questions.clone(),
                tasks,
            )
        };

        match event_type {
            "event.question.requested" => {
                owners
                    .entry(session_id.to_owned())
                    .or_insert_with(owner)
                    .question_requested(payload.clone());
            }

            "event.approval.requested" => {
                owners
                    .entry(session_id.to_owned())
                    .or_insert_with(owner)
                    .poll();
            }

            "event.session.work_changed" => {
                /* 审批没有事件语义之外的可靠清单通知：聚合报 pending_interaction=approval
                时，由对账任务把 REST 清单上挂着的审批拉上桌。 */
                if payload.get("pending_interaction").and_then(Value::as_str) == Some("approval") {
                    owners
                        .entry(session_id.to_owned())
                        .or_insert_with(owner)
                        .poll();
                }

                /* work_changed 是活动投影，不是轮终错误通道：正式结果由 turn.ended
                携带。仅在聚合落定后推进 durable cursor，同轮稍后的 error 事件也在
                续订水位内。 */
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
                        Ok(_) => {}
                        Err(error) => {
                            log::error!("could not close the turn kap just ended: {error}");
                        }
                    }

                    /* 一轮落定，目标的轮数、用量与时长都变了：整表推一次。 */
                    let http2 = http.clone();
                    let base2 = base_url.to_owned();
                    let sid = session_id.to_owned();
                    let events2 = events_tx.clone();

                    tasks.spawn(async move {
                        let (offered, goal) = match get_selectors(&http2, &base2, &sid).await {
                            Ok(snapshot) => snapshot,
                            Err(error) => {
                                log::warn!(
                                    "could not refresh selectors after turn completion: {error}"
                                );
                                return;
                            }
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
                // 仪表值是 volatile 信号（不进帧日志），到达即替换；同帧还挂着累计
                // 输入构成（usage.total，kap events-zod.ts），三格计数与读数一次取走，
                // 这条协议知识全程只有这一处。
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
