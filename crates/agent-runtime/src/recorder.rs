use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{Value, json};

use crate::frame::{RunFrame, prune};
use crate::link::LinkState;
use crate::permission::Decision;
use crate::question::{QuestionGroup, QuestionOutcome};

/// 一帧，已经成形，可以交出去了。
///
/// frame 就是界面读的那一份，也是装载一条旧会话时重播回来的那一份 —— 两者
/// 由同一个 kap_event 做出来，所以重开一条对话与看着它发生不可能对不上。
/// 会话号既在帧里也在这一层：帧是会话发生的事，投递也按同一个主语寻址。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedEvent {
    /// The session the frame belongs to.
    pub session_id: String,
    /// Position within the session, starting at one.
    pub seq: i64,
    /// When it was recorded, in milliseconds since the epoch.
    pub at: i64,
    /// 这一帧本身：判别式与载荷平铺在同一层。
    #[serde(flatten)]
    pub frame: RunFrame,
}

/// 一帧交出去的地方。
///
/// 收的是帧本身，不是它的引用。每一个接收方都要留下这一帧 —— 攒批任务把它
/// 推进通道，重播把它变成 JSON，测试把它存起来 —— 借来的一帧只能靠深拷贝
/// 留下，而 RecordedEvent 里那棵 Value 是按 token 计价的。
pub type FrameSink = Box<dyn FnMut(RecordedEvent) -> bool + Send>;

/// 一条会话上的序号线。
///
/// 位置按会话单调，不按轮次：界面用「seq 单调」去重，而同一条会话上的两轮之间
/// 那道去重必须仍然成立。日志的唯一键也是它（run_events 的
/// UNIQUE (thread_id, session_id, seq)），所以跨进程恢复时要 resume。
///
/// 它的家在会话槽（见 run_slot.rs）：一轮换一轮，位置接着数。
#[derive(Clone, Debug)]
pub struct SeqLine(Arc<AtomicI64>);

impl Default for SeqLine {
    fn default() -> Self {
        Self(Arc::new(AtomicI64::new(1)))
    }
}

impl SeqLine {
    /// 一条从一开始的序号线。
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// 下一帧会站的位置。此刻还没有被用掉。
    fn peek(&self) -> i64 {
        self.0.load(Ordering::Acquire)
    }

    /// 这个位置用掉了。
    fn used(&self, seq: i64) {
        self.0.store(seq.saturating_add(1), Ordering::Release);
    }

    /// 接着日志里记下的最后一个位置往下数。
    ///
    /// 一条会话装载回来时号不变，而它的槽是这次连接新建的、从 1 开始。不接
    /// 上去，新一轮的帧会撞上日志里已有的位置，被 run_events 的唯一键静默
    /// 丢掉。只前进不后退。
    pub fn resume(&self, last: i64) {
        let _previous = self.0.fetch_max(last.saturating_add(1), Ordering::AcqRel);
    }
}

/// 一次运行的帧流：成形，然后投递。
///
/// 两步分开，是为了让序号的语义原样保留：位置在成形时只是被算出来，投递成功
/// 才算用掉。成形失败的那一帧不投递，序号也就不前进。
pub(crate) struct Frames {
    session_id: String,
    seq: SeqLine,
    sink: FrameSink,
}

/// 一个闭包印不出来，但它长在一个公共结构上。
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
    /// 开始一条帧流：帧属于 session_id，位置从它那条序号线上取。
    #[must_use]
    pub(crate) fn new(session_id: String, seq: SeqLine, sink: FrameSink) -> Self {
        Self {
            session_id,
            seq,
            sink,
        }
    }

    /// 给这一帧一个位置和一个时刻。位置此刻还没有被用掉。
    pub(crate) fn shape(&self, frame: RunFrame) -> RecordedEvent {
        RecordedEvent {
            session_id: self.session_id.clone(),
            seq: self.seq.peek(),
            at: now_millis(),
            frame,
        }
    }

    /// 交出去，位置就此用掉。帧的所有权一并交出：这一层此后不再读它。
    pub(crate) fn deliver(&mut self, event: RecordedEvent) -> bool {
        let seq = event.seq;
        if !(self.sink)(event) {
            return false;
        }
        self.seq.used(seq);
        true
    }
}

/// 一轮的记录者：决定此刻发生了哪一种事，然后把它做成一帧交出去。
///
/// 它不写任何存储：帧交给 FrameSink，落库由收帧的那一侧做（桌面 seam 的
/// commands/agent/turn.rs）。这一层因此不需要一个数据库就能测。
///
/// 剩下的那张表是这一轮自己的工作内存：谁在等答复。一轮结束它跟着走，
/// 本来就不该活到下一次启动。
///
/// 帧的形状不在这里定义。这里只决定「此刻发生了哪一种事」，形状由 frame.rs
/// 的 RunFrame 说了算，于是一个拼错的字段名过不了编译。
pub struct Recorder {
    /// 成形与投递。
    frames: Frames,
    /// 还没有人答复的审批，按到达顺序。kap 的审批自带唯一号（approval_id），
    /// 请求号就是它。
    approvals: Vec<String>,
    /// 还没有人答复的题组，按到达顺序。号是 kap 签发的 question_id。
    ///
    /// 与审批分两份记：轮终要放掉的是两类东西，而一张混着两类号的表说不清哪一个
    /// 该按哪一种方式作废。
    questions: Vec<String>,
    /// 已 durable admission、尚未收到 main turn terminal 的数量。
    admitted: usize,
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
    /// Starts recording a turn on one session, forwarding every frame to sink.
    #[must_use]
    pub fn new(session_id: String, seq: SeqLine, sink: FrameSink) -> Self {
        Self {
            admitted: 0,
            frames: Frames::new(session_id, seq, sink),
            approvals: Vec::new(),
            questions: Vec::new(),
        }
    }

    /// Records that the run began, what was asked, and what went out with it.
    pub fn record_prompt_admitted(
        &mut self,
        admission_id: &str,
        prompt: &str,
        images: Vec<String>,
        skills: Vec<String>,
    ) -> bool {
        let accepted = self.append_checked(RunFrame::PromptAdmitted {
            admission_id: admission_id.to_owned(),
            prompt: prompt.to_owned(),
            images,
            skills,
        });
        if accepted {
            self.admitted = self.admitted.saturating_add(1);
        }
        accepted
    }

    /// 记下这一轮的一帧。
    ///
    /// 收的是帧而不是某条协议的通知：成帧在协议侧做（frame.rs 的 kap_event），
    /// 此后共用这一条路。
    pub fn record_frame(&mut self, frame: RunFrame) {
        self.append(frame);
    }

    /// 记下这条连接此刻的链路态。它进这一轮的账，重开这条对话仍然看得见。
    pub fn record_link(&mut self, link: &LinkState) {
        self.append(RunFrame::LinkChanged { link: link.clone() });
    }

    /// Records a kap approval the agent is now blocked on.
    ///
    /// 请求号就是 kap 自己签发的 approval_id：答复从界面回来时，桌子上认的
    /// 也是这个号 —— 不再另铸一个，两处就不用对账。
    pub fn record_permission_requested_kap(
        &mut self,
        approval_id: &str,
        tool_call_id: &str,
        tool_name: &str,
        item: &Value,
    ) -> String {
        self.approvals.push(approval_id.to_owned());

        let title = approval_title(tool_name, item, tool_call_id);

        // 帧是我们自己的契约，不是审批项的原文：界面要的三格在这里归一成
        // camelCase —— toolCallId 是 pendingPermissionCall 反查工具卡片的键，
        // rawInput 装审批项的显示提示（approvalRequestSchema 的
        // tool_input_display）。其余格子是传输层的事，帧不留。
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

    /// Records the answer a kap approval was settled with.
    pub fn record_permission_resolved_kap(&mut self, approval_id: &str, decision: Decision) {
        self.note_resolution(approval_id, decision);
    }

    /// The requests this run is still waiting on.
    ///
    /// 一轮结束时要从权限桌上放掉的就是这些。
    pub fn outstanding_permissions(&self) -> &[String] {
        &self.approvals
    }

    /// Settles every ask still outstanding when the turn ended.
    ///
    /// 两类都要放掉，各按自己的方式：一个没答的审批以取消收场，一组没答的题以
    /// cancelled 收场 —— 它不是「被撤下」，撤下是人做的事。
    pub fn record_pending_cancelled(&mut self) {
        // 先取走再逐个记：每一次记录都会把它自己从清单里划掉，边遍历边改
        // 同一个 Vec 是借用检查器本来就不允许的事。
        for approval_id in std::mem::take(&mut self.approvals) {
            self.record_permission_resolved_kap(&approval_id, Decision::Cancelled);
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

    /// Records the group of questions the agent is now blocked on.
    pub fn record_questions_asked(&mut self, group: &QuestionGroup) {
        self.questions.push(group.question_id.clone());

        self.append(RunFrame::QuestionsAsked {
            question_id: group.question_id.clone(),
            tool_call_id: group.tool_call_id.clone().unwrap_or_default(),
            questions: group.on_frame(),
        });
    }

    /// Records how one group of questions was settled.
    ///
    /// undelivered 是这一侧的收场：人答了，但答案没送到 agent 手上。它必须与
    /// answered 分开 —— 否则时间线会说「已回答」而 agent 还在等。
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

    /// The question groups this run is still waiting on.
    pub fn outstanding_questions(&self) -> &[String] {
        &self.questions
    }

    /// Records that the run ended on the agent's terms.
    pub fn record_run_finished(&mut self, stop_reason: &str) {
        self.append(RunFrame::RunFinished {
            stop_reason: stop_reason.to_owned(),
        });
        self.admitted = self.admitted.saturating_sub(1);
    }

    /// Records that the run ended in a failure.
    pub fn record_run_failed(&mut self, message: &str) {
        self.append(RunFrame::RunFailed {
            message: message.to_owned(),
        });
        self.admitted = self.admitted.saturating_sub(1);
    }

    fn note_resolution(&mut self, request_id: &str, decision: Decision) {
        self.approvals.retain(|waiting| waiting != request_id);

        self.append(RunFrame::PermissionResolved {
            request_id: request_id.to_owned(),
            decision: decision.on_wire().to_owned(),
            scope: decision.scope().map(|scope| scope.on_wire().to_owned()),
        });
    }

    /// 成形，然后投递。位置在投递时才算用掉，见 Frames::shape。
    fn append_checked(&mut self, frame: RunFrame) -> bool {
        let event = self.frames.shape(frame);
        self.frames.deliver(event)
    }

    fn append(&mut self, frame: RunFrame) {
        let _accepted = self.append_checked(frame);
    }

    /// 这条会话此刻有没有一轮在飞。终帧只在飞的那一轮上落一次。
    pub const fn is_running(&self) -> bool {
        self.admitted > 0
    }
}

/// 界面要求有标题；kap 的审批一定带工具名（approvalRequestSchema 的
/// tool_name 是 min(1)），动作与入参在它的载荷里。名不在才轮到动作，
/// 都不在就报调用号 —— 空标题比没有标题的卡片更糟。
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

/// 现在，毫秒。
///
/// 时钟走在 1970 之前、或者走过 i64 毫秒能表示的尽头时算 0。两处兜底都是有意
/// 的：帧上的时刻是给人看的排序依据，让一次记录因为系统时钟不对劲而失败，换来
/// 的是一条对话在屏幕上断掉 —— 代价不对等。
#[must_use]
pub(crate) fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| i64::try_from(elapsed.as_millis()).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    // 与 tests/recorder.rs 顶上那一句同一条纪律、同一个理由：根 clippy.toml 的
    // allow-expect-in-tests 只认 #[test] 与 #[cfg(test)] 模块，盖不住集成测试里
    // 的辅助方法，放开只能逐处写出来。
    #![allow(
        clippy::expect_used,
        reason = "a test proves itself by panicking, so a failed step must fail the test"
    )]

    use std::sync::{Arc, Mutex};

    use super::{Frames, RecordedEvent, SeqLine};
    use crate::frame::RunFrame;

    fn ending() -> RunFrame {
        RunFrame::RunFinished {
            stop_reason: "end_turn".to_owned(),
        }
    }

    /// 落库失败的那一帧不该在日志里留下一个空号，所以成形不占位置。
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
}
