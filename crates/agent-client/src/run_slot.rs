use std::sync::{Arc, Mutex};

use crate::error::{AgentError, Result};
use crate::recorder::{Recorder, SeqLine};

/// 处理器与一轮的寿命对不上，隔槽相见；没人在听时到达的更新被丢掉，不记到前一轮头上。
#[derive(Clone, Debug, Default)]
pub struct RunSlot {
    current: Arc<Mutex<Option<Recorder>>>,
    seq: SeqLine,
}

impl RunSlot {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn seq(&self) -> SeqLine {
        self.seq.clone()
    }

    /// 幂等：记录器只装一次，帧因此始终落在同一条序号线上。
    pub fn attach(&self, make: impl FnOnce() -> Recorder) -> Result<()> {
        let mut current = self
            .current
            .lock()
            .map_err(|_poisoned| AgentError::Poisoned)?;

        if current.is_none() {
            *current = Some(make());
        }

        Ok(())
    }

    pub fn record(&self, action: impl FnOnce(&mut Recorder)) -> bool {
        match self.current.lock() {
            Ok(mut current) => match current.as_mut() {
                Some(recorder) => {
                    action(recorder);

                    true
                }
                None => false,
            },
            // 锁坏了（别的任务 panic 过）：这一帧丢掉，失败由驱动那侧已握着的那个报。
            Err(_poisoned) => false,
        }
    }
}
