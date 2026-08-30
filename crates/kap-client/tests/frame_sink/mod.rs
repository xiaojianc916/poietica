//! 一个能读回来的 FrameSink。
//!
//! Cargo 把 tests 下每一个 .rs 各编成一个 crate（Cargo Book, Cargo Targets ▸
//! Tests），所以夹具写在文件里就是每个目标各写一份。收帧的契约只有一处定义，
//! 观察它的办法也只该有一处 —— 上一次两者分了家，签名就只改到了一半。
//!
//! 这个目录本身不是测试目标：Cargo 只认 tests/*.rs 与 tests/*/main.rs。

#![allow(
    dead_code,
    reason = "each test target is its own crate, so an item this one does not use is not unused"
)]
#![allow(
    clippy::expect_used,
    reason = "a test proves itself by panicking, so a failed step must fail the test"
)]

use std::sync::{Arc, Mutex};

use poietica_kap_client::{FrameSink, RecordedEvent, Recorder, SeqLine};
use serde_json::Value;

/// 这些夹具录的那一条会话。
pub(crate) const SESSION: &str = "sess_alpha";

/// 一个水槽收下的帧，按到达顺序。
#[derive(Debug, Default)]
pub(crate) struct Delivered(Arc<Mutex<Vec<RecordedEvent>>>);

impl Delivered {
    /// 交到这里来的那个水槽。
    ///
    /// 帧按值收下，与 FrameSink 一致：接收方要把这一帧留下，而借来的一帧只能
    /// 靠深拷贝留下。
    pub(crate) fn sink(&self) -> FrameSink {
        let kept = Arc::clone(&self.0);

        Box::new(move |event: RecordedEvent| {
            if let Ok(mut held) = kept.lock() {
                held.push(event);
            }
            true
        })
    }

    /// 收到的帧本身。
    pub(crate) fn frames(&self) -> Vec<RecordedEvent> {
        self.read(RecordedEvent::clone)
    }

    /// 每一帧站的位置。
    pub(crate) fn positions(&self) -> Vec<i64> {
        self.read(|event| event.seq)
    }

    /// 帧按界面收到的形状读回来。
    ///
    /// 序列化的是整个 RecordedEvent 而不是它的 frame：跨进程投递的就是它，而
    /// serde 的 flatten 让判别式与载荷跟 sessionId、seq、at 平铺在同一层。断言
    /// 看到的因此与界面看到的是同一份 JSON。
    pub(crate) fn wire(&self) -> Vec<Value> {
        self.read(|event| serde_json::to_value(event).expect("the frame serialises"))
    }

    fn read<T>(&self, project: impl FnMut(&RecordedEvent) -> T) -> Vec<T> {
        self.0
            .lock()
            .expect("the sink")
            .iter()
            .map(project)
            .collect()
    }
}

/// 一个记录器，和它交出来的帧。
pub(crate) fn recording() -> (Recorder, Delivered) {
    let delivered = Delivered::default();
    let recorder = Recorder::new(SESSION.to_owned(), SeqLine::new(), delivered.sink());

    (recorder, delivered)
}

/// 帧上某个字段的字符串值，没有就是空串。
pub(crate) fn text_of(frame: &Value, field: &str) -> String {
    frame
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}
