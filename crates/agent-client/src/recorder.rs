use poietica_time::WallClock;
use std::collections::VecDeque;
use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use serde::Serialize;
use serde_json::{Value, json};

use crate::frame::{RunFrame, prune};
use crate::interaction::permission::{ApprovalResponse, Decision};
use crate::interaction::question::{QuestionGroup, QuestionOutcome};
use poietica_conversation::link::LinkState;

/// 一帧，已经成形，可以交出去了。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedEvent {
    pub session_id: String,
    pub seq: i64,
    pub at: i64,
    #[serde(flatten)]
    pub frame: RunFrame,
}

/// 一帧交出去的地方。在 RunSlot 的锁内被调用，契约是不阻塞；false = 拒收，位置不前进。
pub type FrameSink = Box<dyn FnMut(RecordedEvent) -> bool + Send>;

/// 投递侧的会话内序号：账本按对话另发号，这里的号不进账。
#[derive(Clone, Debug)]
pub struct SeqLine(Arc<AtomicI64>);

impl Default for SeqLine {
    fn default() -> Self {
        Self(Arc::new(AtomicI64::new(1)))
    }
}

impl SeqLine {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn peek(&self) -> i64 {
        self.0.load(Ordering::Acquire)
    }

    fn used(&self, seq: i64) {
        let _previous = self.0.fetch_max(seq.saturating_add(1), Ordering::AcqRel);
    }
}

/// 成形与投递两段式：shape 只算位置，deliver 成功才占号；投递失败序号不前进。
pub(crate) struct Frames {
    session_id: String,
    seq: SeqLine,
    sink: FrameSink,
}

impl fmt::Debug for Frames {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Frames")
            .field("session_id", &self.session_id)
            .field("seq", &self.seq)
            .finish_non_exhaustive()
    }
}

impl Frames {
    #[must_use]
    pub(crate) fn new(session_id: String, seq: SeqLine, sink: FrameSink) -> Self {
        Self {
            session_id,
            seq,
            sink,
        }
    }

    /// 只成形：位置此刻还没用掉，deliver 成功才占号。
    pub(crate) fn shape(&self, frame: RunFrame) -> RecordedEvent {
        RecordedEvent {
            session_id: self.session_id.clone(),
            seq: self.seq.peek(),
            at: now_millis(),
            frame,
        }
    }

    /// 交出去，位置就此用掉。
    pub(crate) fn deliver(&mut self, event: RecordedEvent) -> bool {
        let seq = event.seq;
        if !(self.sink)(event) {
            return false;
        }
        self.seq.used(seq);
        true
    }
}

/// 一轮的记录者：决定此刻发生哪一种事并做成一帧交出；落库归收帧侧，形状归 frame.rs。
pub struct Recorder {
    frames: Frames,
    approvals: Vec<String>,
    questions: Vec<String>,
    /// 已准入、尚无终局的 prompt id；队首即在跑的那一句（abort 点名要它）。
    in_flight: VecDeque<String>,
    ended: u64,
    lost: u64,
    pending_end: Option<RunFrame>,
    /// 最近一轮是怎么结束的。本机答「这次提交怎么样了」要用它：不在飞时就说明
    /// 已经落过终帧，终帧只有撤/成/败三种。
    last_end: Option<&'static str>,
}

impl fmt::Debug for Recorder {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Recorder")
            .field("frames", &self.frames)
            .finish_non_exhaustive()
    }
}

impl Recorder {
    #[must_use]
    pub fn new(session_id: String, seq: SeqLine, sink: FrameSink) -> Self {
        Self {
            in_flight: VecDeque::new(),
            ended: 0,
            lost: 0,
            pending_end: None,
            last_end: None,
            frames: Frames::new(session_id, seq, sink),
            approvals: Vec::new(),
            questions: Vec::new(),
        }
    }

    /// admission_id 同时是 wire 上的 prompt_id（ADR 0026：kap 原样认它），也是取消点名的依据。
    pub fn record_prompt_admitted(
        &mut self,
        admission_id: &str,
        prompt: &str,
        skills: Vec<String>,
    ) -> bool {
        self.settle_pending_end();

        let accepted = self.append_checked(RunFrame::PromptAdmitted {
            admission_id: admission_id.to_owned(),
            prompt: prompt.to_owned(),
            skills,
        });
        if accepted {
            self.in_flight.push_back(admission_id.to_owned());
        }
        accepted
    }

    pub fn record_session_recovered(&mut self, snapshot: Value) {
        self.append(RunFrame::SessionRecovered { snapshot });
    }

    pub fn record_link(&mut self, link: &LinkState) {
        self.append(RunFrame::LinkChanged { link: link.clone() });
    }

    /// 请求号就是 kap 签发的 approval_id，不另铸一个，两处免对账。
    pub fn record_permission_requested_kap(
        &mut self,
        approval_id: &str,
        tool_call_id: &str,
        tool_name: &str,
        item: &Value,
    ) -> String {
        self.approvals.push(approval_id.to_owned());

        let title = approval_title(tool_name, item, tool_call_id);

        // rawInput 装审批项的显示提示（tool_input_display），由 transcript-projector 的 interactionOf 落成展示格。
        let mut tool_call = json!({
            "toolCallId": tool_call_id,
            "title": title,
            "rawInput": item.get("tool_input_display").cloned().unwrap_or(Value::Null),
        });
        prune(&mut tool_call);

        self.append(RunFrame::PermissionRequested {
            request_id: approval_id.to_owned(),
            tool_call_id: tool_call_id.to_owned(),
            title,
            tool_call,
        });

        approval_id.to_owned()
    }

    pub fn record_permission_resolved_kap(
        &mut self,
        approval_id: &str,
        response: ApprovalResponse,
    ) {
        self.note_resolution(approval_id, response);
    }

    pub fn record_pending_cancelled(&mut self) {
        for approval_id in std::mem::take(&mut self.approvals) {
            self.record_permission_resolved_kap(
                &approval_id,
                ApprovalResponse {
                    decision: Decision::Cancelled,
                    selected_label: None,
                    feedback: None,
                },
            );
        }

        for question_id in std::mem::take(&mut self.questions) {
            self.append(RunFrame::QuestionsResolved {
                question_id,
                outcome: "cancelled".to_owned(),
                answers: Value::Array(Vec::new()),
                note: String::new(),
            });
        }
    }

    pub fn record_questions_asked(&mut self, group: &QuestionGroup) {
        self.questions.push(group.question_id.clone());

        self.append(RunFrame::QuestionsAsked {
            question_id: group.question_id.clone(),
            tool_call_id: group.tool_call_id.clone().unwrap_or_default(),
            questions: group.on_frame(),
        });
    }

    /// undelivered：人答了但没送到 agent 手上，必须与 answered 分开。
    pub fn record_questions_resolved(
        &mut self,
        group: &QuestionGroup,
        outcome: &QuestionOutcome,
        delivered: bool,
    ) {
        self.questions
            .retain(|waiting| waiting != &group.question_id);

        let (answers, note, settled) = match outcome {
            QuestionOutcome::Answered(response) => (
                response.on_frame(group),
                response.note.clone().unwrap_or_default(),
                if delivered { "answered" } else { "undelivered" },
            ),
            QuestionOutcome::Dismissed => (
                Value::Array(Vec::new()),
                String::new(),
                if delivered {
                    "dismissed"
                } else {
                    "undelivered"
                },
            ),
        };

        self.append(RunFrame::QuestionsResolved {
            question_id: group.question_id.clone(),
            outcome: settled.to_owned(),
            answers,
            note,
        });
    }

    pub fn record_run_finished(&mut self, stop_reason: &str) {
        let ending = match self.lost {
            0 => RunFrame::RunFinished {
                stop_reason: stop_reason.to_owned(),
            },
            lost => RunFrame::RunFailed {
                message: format!("the frame journal dropped {lost} frames of this turn"),
            },
        };

        self.last_end = Some(match &ending {
            RunFrame::RunFinished { stop_reason } => match stop_reason.as_str() {
                "cancelled" => "cancelled",
                "failed" => "failed",
                _ => "completed",
            },
            _ => "failed",
        });

        self.end_with(ending);
    }

    pub fn record_run_failed(&mut self, message: &str) {
        self.last_end = Some("failed");

        self.end_with(RunFrame::RunFailed {
            message: message.to_owned(),
        });
    }

    /// 终帧的唯一落点：落下去才算一轮结束。
    fn end_with(&mut self, ending: RunFrame) {
        self.pending_end = Some(ending);

        self.settle_pending_end();
    }

    /// 补投上一次落不下去的终帧，排在后来的帧之前。
    fn settle_pending_end(&mut self) {
        let Some(ending) = self.pending_end.take() else {
            return;
        };

        if !self.append_checked(ending.clone()) {
            self.pending_end = Some(ending);

            return;
        }

        self.lost = 0;
        let _settled = self.in_flight.pop_front();
        self.ended = self.ended.saturating_add(1);
    }

    fn note_resolution(&mut self, request_id: &str, response: ApprovalResponse) {
        self.approvals.retain(|waiting| waiting != request_id);

        self.append(RunFrame::PermissionResolved {
            request_id: request_id.to_owned(),
            decision: response.decision.on_wire().to_owned(),
            scope: response
                .decision
                .scope()
                .map(|scope| scope.on_wire().to_owned()),
            selected_label: response.selected_label,
            feedback: response.feedback,
        });
    }

    fn append_checked(&mut self, frame: RunFrame) -> bool {
        let event = self.frames.shape(frame);
        self.frames.deliver(event)
    }

    fn append(&mut self, frame: RunFrame) {
        self.settle_pending_end();

        if !self.append_checked(frame) {
            self.lost = self.lost.saturating_add(1);
        }
    }

    pub fn is_running(&self) -> bool {
        !self.in_flight.is_empty()
    }

    pub fn current_prompt(&self) -> Option<&str> {
        self.in_flight.front().map(String::as_str)
    }

    /// 这个 prompt 还在飞吗。
    pub fn holds(&self, prompt: &str) -> bool {
        self.in_flight.iter().any(|held| held == prompt)
    }

    /// 最近一轮的结局：completed、cancelled 或 failed；还没跑过就是 None。
    pub fn last_outcome(&self) -> Option<&'static str> {
        self.last_end
    }

    /// 已落终帧数，用作一轮的身份（取消宽限期认轮）。
    pub const fn ended(&self) -> u64 {
        self.ended
    }
}

/// kap 审批必带 tool_name（approvalRequestSchema min(1)）；名缺才轮到动作，再缺报调用号。
fn approval_title(tool_name: &str, item: &Value, tool_call_id: &str) -> String {
    if !tool_name.is_empty() {
        return tool_name.to_owned();
    }

    item.get("action")
        .and_then(Value::as_str)
        .filter(|action| !action.is_empty())
        .unwrap_or(tool_call_id)
        .to_owned()
}

/// 现在，毫秒；时钟异常时算 0 —— 帧时刻只作排序，不值得为此断掉一条对话。
#[must_use]
pub(crate) fn now_millis() -> i64 {
    poietica_time::wall_clock::SystemWallClock.now_unix_millis()
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        reason = "a test proves itself by panicking, so a failed step must fail the test"
    )]

    use std::sync::{Arc, Mutex};

    use super::{Frames, RecordedEvent, Recorder, SeqLine};
    use crate::frame::RunFrame;
    use poietica_conversation::link::LinkState;

    fn ending() -> RunFrame {
        RunFrame::RunFinished {
            stop_reason: "end_turn".to_owned(),
        }
    }

    #[test]
    fn a_position_is_used_up_only_once_the_frame_is_delivered() {
        let seen: Arc<Mutex<Vec<i64>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);

        let mut frames = Frames::new(
            "sess_alpha".to_owned(),
            SeqLine::new(),
            Box::new(move |event: RecordedEvent| {
                if let Ok(mut held) = sink.lock() {
                    held.push(event.seq);
                }
                true
            }),
        );

        let shaped = frames.shape(ending());

        assert_eq!(shaped.seq, 1);
        assert_eq!(
            frames.shape(ending()).seq,
            1,
            "成形两次仍是同一个位置：没有投递就没有用掉"
        );

        frames.deliver(shaped);

        assert_eq!(frames.shape(ending()).seq, 2, "投递之后位置才前进");
        assert_eq!(*seen.lock().expect("the sink is readable"), vec![1]);
    }

    #[test]
    fn a_refused_ending_lands_once_the_journal_catches_up() {
        let refusing = Arc::new(Mutex::new(false));
        let gate = Arc::clone(&refusing);
        let seen: Arc<Mutex<Vec<RunFrame>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);

        let mut recorder = Recorder::new(
            "sess_beta".to_owned(),
            SeqLine::new(),
            Box::new(move |event: RecordedEvent| {
                if gate.lock().is_ok_and(|closed| *closed) {
                    return false;
                }

                if let Ok(mut held) = sink.lock() {
                    held.push(event.frame);
                }

                true
            }),
        );

        assert!(recorder.record_prompt_admitted("adm", "hi", Vec::new()));

        *refusing.lock().expect("the gate is writable") = true;
        recorder.record_link(&LinkState::Recovered {
            reason: "lost".to_owned(),
        });
        recorder.record_run_finished("end_turn");

        assert!(recorder.is_running(), "终帧没落账，这一轮就还没结束");
        assert_eq!(recorder.ended(), 0);

        *refusing.lock().expect("the gate is writable") = false;
        recorder.record_link(&LinkState::Recovered {
            reason: "back".to_owned(),
        });

        assert!(!recorder.is_running());
        assert_eq!(recorder.ended(), 1);
        assert!(
            seen.lock()
                .is_ok_and(|held| matches!(held.get(1), Some(RunFrame::RunFailed { .. }))),
            "丢过帧的一轮不能报正常结束"
        );
    }

    #[test]
    fn the_running_prompt_is_the_first_unsettled_admission() {
        let mut recorder = Recorder::new(
            "sess_gamma".to_owned(),
            SeqLine::new(),
            Box::new(|_event| true),
        );

        assert_eq!(recorder.current_prompt(), None);
        assert!(recorder.record_prompt_admitted("first", "hi", Vec::new()));
        assert!(recorder.record_prompt_admitted("second", "again", Vec::new()));
        assert_eq!(recorder.current_prompt(), Some("first"));

        recorder.record_run_finished("end_turn");
        assert_eq!(recorder.current_prompt(), Some("second"));

        recorder.record_run_finished("end_turn");
        assert_eq!(recorder.current_prompt(), None);
    }
}
