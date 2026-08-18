use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use agent_client_protocol::schema::v1::{RequestPermissionRequest, SessionUpdate};
use serde::Serialize;
use uuid::Uuid;

use crate::error::{AcpError, Result};
use crate::frame::{RunFrame, prune};
use crate::permission::Decision;

/// 一帧，已经成形，可以交出去了。
///
/// `frame` 就是界面读的那一份，也是装载一条旧会话时重播回来的那一份 —— 两者
/// 由同一个 `acp_update` 做出来，所以重开一条对话与看着它发生不可能对不上。
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
    ///
    /// 六种里有五种装的是帧本身，序列化留到它离开进程那一刻由 Tauri 做一次。
    /// `AcpUpdate` 不是：它那一格 `FrameNotification::update` 已经是一棵
    /// `Value`，在 SDK 的通知处理器里就做好了（见 `frame::acp_update`）。流式
    /// 期间几乎每一帧都是这一种。
    #[serde(flatten)]
    pub frame: RunFrame,
}

/// 一帧交出去的地方。
///
/// 收的是帧本身，不是它的引用。每一个接收方都要留下这一帧 —— 攒批任务把它
/// 推进通道，重播把它变成 JSON，测试把它存起来 —— 借来的一帧只能靠深拷贝
/// 留下，而 `RecordedEvent` 里那棵 `Value` 是按 token 计价的。
pub type FrameSink = Box<dyn FnMut(RecordedEvent) + Send>;

/// 一条会话上的序号线。
///
/// 位置按会话单调，不按轮次：界面用「seq 单调」去重，而同一条会话上的两轮之间
/// 那道去重必须仍然成立。日志的唯一键也是它（run_events 的
/// `UNIQUE (thread_id, session_id, seq)`），所以跨进程恢复时要 `resume`。
///
/// 它的家在会话槽（见 `run_slot.rs`）：一轮换一轮，位置接着数。
#[derive(Clone, Debug)]
pub struct SeqLine(Arc<AtomicI64>);

impl PartialEq for SeqLine {
    fn eq(&self, other: &Self) -> bool {
        self.peek() == other.peek()
    }
}

impl Eq for SeqLine {}

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
    /// 开始一条帧流：帧属于 `session_id`，位置从它那条序号线上取。
    #[must_use]
    pub(crate) fn new(session_id: String, seq: SeqLine, sink: FrameSink) -> Self {
        Self {
            session_id,
            seq,
            sink,
        }
    }

    /// 给这一帧一个位置和一个时刻。位置此刻还没有被用掉。
    ///
    /// 它不会失败：这里不再序列化任何东西，只是给帧配上它的地址。
    pub(crate) fn shape(&self, frame: RunFrame) -> RecordedEvent {
        RecordedEvent {
            session_id: self.session_id.clone(),
            seq: self.seq.peek(),
            at: now_millis(),
            frame,
        }
    }

    /// 交出去，位置就此用掉。帧的所有权一并交出：这一层此后不再读它。
    pub(crate) fn deliver(&mut self, event: RecordedEvent) {
        self.seq.used(event.seq);

        (self.sink)(event);
    }
}

/// 一轮的记录者：决定此刻发生了哪一种事，然后把它做成一帧交出去。
///
/// 它不写任何存储：帧交给 `FrameSink`，落库由收帧的那一侧做（桌面 seam 的
/// commands/agent/turn.rs）。这一层因此不需要一个数据库就能测。
///
/// 剩下的两张表是这一轮自己的工作内存：见过的工具调用叫什么，还有谁在等
/// 答复。一轮结束它们跟着走，本来就不该活到下一次启动。
///
/// 帧的形状不在这里定义。这里只决定「此刻发生了哪一种事」，形状由 frame.rs
/// 的 `RunFrame` 说了算，于是一个拼错的字段名过不了编译。
pub struct Recorder {
    /// 成形与投递。
    frames: Frames,
    failure: Option<AcpError>,
    /// What the agent said on its own error stream during this run.
    diagnostics: String,
    /// How many session updates this run carried.
    updates: u32,
    /// 这一轮见过的工具调用叫什么。
    ///
    /// 权限请求可以不带标题，界面却要求有一个。退路就在这一轮自己的工作内存
    /// 里，一轮结束跟着走：它不是历史，不该进任何存储。
    titles: HashMap<String, String>,
    /// 还没有人答复的权限请求，按到达顺序。
    pending: Vec<String>,
}

impl fmt::Debug for Recorder {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Recorder")
            .field("frames", &self.frames)
            .field("failed", &self.failure.is_some())
            .finish_non_exhaustive()
    }
}

impl Recorder {
    /// Starts recording a turn on one session, forwarding every frame to `sink`.
    #[must_use]
    pub fn new(session_id: String, seq: SeqLine, sink: FrameSink) -> Self {
        Self {
            frames: Frames::new(session_id, seq, sink),
            failure: None,
            diagnostics: String::new(),
            updates: 0,
            titles: HashMap::new(),
            pending: Vec::new(),
        }
    }

    /// Hands over what the agent said on its own error stream.
    pub fn set_diagnostics(&mut self, text: String) {
        self.diagnostics = text;
    }

    /// Takes the first failure observed while recording, if there was one.
    pub fn take_failure(&mut self) -> Option<AcpError> {
        self.failure.take()
    }

    /// Records that the run began, what was asked, and what was shown with it.
    pub fn record_run_started(&mut self, prompt: &str, images: Vec<String>) {
        self.append(RunFrame::RunStarted {
            prompt: prompt.to_owned(),
            images,
        });
    }

    /// 记下这一轮的一帧。
    ///
    /// 收的是帧而不是某条协议的通知：成帧在协议侧做，此后共用这一条路。
    /// 会话帧要计数 —— 一轮到底有没有内容，`narrate` 靠它判断。
    pub fn record_frame(&mut self, frame: RunFrame) {
        if matches!(frame, RunFrame::AcpUpdate { .. }) {
            self.updates = self.updates.saturating_add(1);
        }

        self.append(frame);
    }

    /// 成帧没成，算这一轮的失败。
    ///
    /// 成帧在协议侧做，所以失败也在那里发生；归属仍然属于这一轮，判据不变：
    /// 第一个失败留下，后面的不覆盖它。
    pub fn note_unencodable(&mut self, error: AcpError) {
        self.remember(Err(error));
    }

    /// 记下这一轮见过的工具调用叫什么。
    ///
    /// 权限请求可以不带标题，而界面要求有一个：退路是这一轮见过的那些名字。
    pub fn note_tool_titles(&mut self, update: &SessionUpdate) {
        self.project(update);
    }

    /// Records a permission request the agent is now blocked on.
    pub fn record_permission_requested(&mut self, request: &RequestPermissionRequest) -> String {
        let request_id = Uuid::now_v7().to_string();
        let tool_call_id = request.tool_call.tool_call_id.to_string();
        let outcome = self.note_request(&request_id, &tool_call_id, request);

        self.remember(outcome);

        request_id
    }

    /// Records the answer a permission request was settled with.
    pub fn record_permission_resolved(&mut self, request_id: &str, decision: &Decision) {
        self.note_resolution(request_id, decision);
    }

    /// The requests this run is still waiting on.
    ///
    /// 一轮结束时要从权限桌上放掉的就是这些。请求号是这个记录器自己发的，
    /// 答复也从它手上过，所以这份清单本来就在它这里。
    pub fn outstanding_permissions(&self) -> &[String] {
        &self.pending
    }

    /// Settles every request still outstanding when the turn ended.
    pub fn record_pending_cancelled(&mut self) {
        // 先取走再逐个记：每一次记录都会把它自己从清单里划掉，边遍历边改
        // 同一个 Vec 是借用检查器本来就不允许的事。
        for request_id in std::mem::take(&mut self.pending) {
            self.record_permission_resolved(&request_id, &Decision::Cancel);
        }
    }

    /// Records that the run ended on the agent's terms.
    pub fn record_run_finished(&mut self, stop_reason: &str) {
        self.finish(RunFrame::RunFinished {
            stop_reason: stop_reason.to_owned(),
            diagnostics: None,
        });
    }

    /// Records that the run ended in a failure.
    pub fn record_run_failed(&mut self, message: &str) {
        self.finish(RunFrame::RunFailed {
            message: message.to_owned(),
            diagnostics: None,
        });
    }

    fn project(&mut self, update: &SessionUpdate) {
        match update {
            SessionUpdate::ToolCall(call) => {
                self.titles
                    .insert(call.tool_call_id.to_string(), call.title.clone());
            }
            SessionUpdate::ToolCallUpdate(change) => {
                // 一次更新可以先于它的宣告到达：子代理在自己的会话号下发起的调用、
                // 装载回来的历史、以及 agent 把首帧直接合并进更新，都是协议允许的。
                // 界面侧的 upsertToolCall 一直是这么读的（"a tool_call_update for
                // an unknown id creates a placeholder"），而此前这里把同一件事判成
                // 整轮失败 —— 同一个协议事实在两条管线上有两种语义。
                if let Some(renamed) = change.fields.title.clone() {
                    let _upserted = self.titles.insert(change.tool_call_id.to_string(), renamed);
                }
            }
            // 协议还会长出新的更新种类。它们照样成帧交出去，只是这一轮的
            // 工作内存里没有它们的位置。
            _ => {}
        }
    }

    fn note_request(
        &mut self,
        request_id: &str,
        tool_call_id: &str,
        request: &RequestPermissionRequest,
    ) -> Result<()> {
        self.pending.push(request_id.to_owned());

        let mut options = serde_json::to_value(&request.options)?;
        let mut tool_call = serde_json::to_value(&request.tool_call)?;

        prune(&mut options);
        prune(&mut tool_call);

        let title = self.permission_title(request, tool_call_id);

        self.append(RunFrame::PermissionRequested {
            request_id: request_id.to_owned(),
            tool_call_id: tool_call_id.to_owned(),
            title,
            tool_call,
            options,
        });

        Ok(())
    }

    fn note_resolution(&mut self, request_id: &str, decision: &Decision) {
        // Refusing by choosing the agent's own refusal option is still a
        // selection as far as the protocol is concerned. Only an unanswered
        // request is cancelled.
        let (option_id, outcome) = match decision {
            Decision::Allow(option_id) | Decision::Reject(option_id) => {
                (option_id.to_string(), "selected")
            }
            Decision::Cancel => (String::new(), "cancelled"),
        };

        self.pending.retain(|waiting| waiting != request_id);

        self.append(RunFrame::PermissionResolved {
            request_id: request_id.to_owned(),
            option_id,
            outcome: outcome.to_owned(),
        });
    }

    /// The interface requires a title; the protocol makes it optional.
    ///
    /// 退而求其次的那个标题来自这一轮自己见过的工具调用。每一次 `ToolCall`
    /// 与每一次改名都从 `project` 过一遍，所以这里不必回头去查日志。
    fn permission_title(&self, request: &RequestPermissionRequest, tool_call_id: &str) -> String {
        if let Some(title) = request.tool_call.fields.title.clone() {
            return title;
        }

        self.titles
            .get(tool_call_id)
            .cloned()
            .unwrap_or_else(|| tool_call_id.to_owned())
    }

    fn finish(&mut self, frame: RunFrame) {
        let frame = self.narrate(frame);

        self.append(frame);
    }

    /// A failure always carries the agent account of it. A turn that ended on
    /// the agent terms carries it only when the protocol carried nothing, so a
    /// healthy turn is not narrated by its own logging.
    fn narrate(&self, frame: RunFrame) -> RunFrame {
        if self.diagnostics.is_empty() {
            return frame;
        }

        let said = Some(self.diagnostics.clone());

        match frame {
            RunFrame::RunFailed { message, .. } => RunFrame::RunFailed {
                message,
                diagnostics: said,
            },
            RunFrame::RunFinished { stop_reason, .. } if self.updates == 0 => {
                RunFrame::RunFinished {
                    stop_reason,
                    diagnostics: said,
                }
            }
            other => other,
        }
    }

    /// 成形，然后投递。位置在投递时才算用掉，见 [`Frames::shape`]。
    fn append(&mut self, frame: RunFrame) {
        let event = self.frames.shape(frame);

        self.frames.deliver(event);
    }

    fn remember(&mut self, outcome: Result<()>) {
        if let Err(error) = outcome
            && self.failure.is_none()
        {
            self.failure = Some(error);
        }
    }
}

/// 现在，毫秒。
///
/// 时钟走在 1970 之前、或者走过 i64 毫秒能表示的尽头时算 0。两处兜底都是有意
/// 的：帧上的时刻是给人看的排序依据，让一次记录因为系统时钟不对劲而失败，换来
/// 的是一条对话在屏幕上断掉 —— 代价不对等。
#[must_use]
pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| i64::try_from(elapsed.as_millis()).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    // 与 tests/recorder.rs 顶上那一句同一条纪律、同一个理由：仓库根没有
    // clippy.toml，也就没有 allow-expect-in-tests，放开只能逐处写出来。
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
            diagnostics: None,
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
