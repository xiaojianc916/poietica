use std::sync::{Arc, Mutex};

use crate::error::{KapError, Refusal, Result};
use crate::recorder::{Recorder, SeqLine};

/// 到达的会话更新交给谁。
///
/// 协议处理器装一次，管整条连接；记录器只活一轮。两个寿命对不上，所以处理器
/// 不拥有记录器，它们隔着这个槽相见。
///
/// 没人在听时到达的更新被丢掉，而不是记到恰好排在它前面的那一轮头上 ——
/// `session/load` 期间正是这种情形：那批重放帧的持有者是 agent。
#[derive(Clone, Debug, Default)]
pub struct RunSlot {
    current: Arc<Mutex<Option<Recorder>>>,
    /// 这条会话的序号线。它比任何一轮都活得久，所以位置的家在这里。
    seq: SeqLine,
}

impl RunSlot {
    /// 一个空槽，没有一轮在飞。
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// 这条会话的序号线。一轮换一轮，位置接着数。
    #[must_use]
    pub fn seq(&self) -> SeqLine {
        self.seq.clone()
    }

    /// 让这一轮来收接下来的更新。
    ///
    /// # Errors
    ///
    /// 已经有一轮在飞时报错 —— 一条会话上的第二轮就是这么被拒的；锁坏了也报错。
    pub fn install(&self, recorder: Recorder) -> Result<()> {
        let mut current = self
            .current
            .lock()
            .map_err(|_poisoned| KapError::Poisoned)?;

        if current.is_some() {
            return Err(KapError::Refused(Refusal::Busy));
        }

        *current = Some(recorder);

        Ok(())
    }

    /// 这一轮结束，把记录器交回去，好让它自己收尾。
    ///
    /// # Errors
    ///
    /// 锁坏了时报错。
    pub fn take(&self) -> Result<Option<Recorder>> {
        let mut current = self
            .current
            .lock()
            .map_err(|_poisoned| KapError::Poisoned)?;

        Ok(current.take())
    }

    /// 对此刻在飞的那一轮做一件事，并交代有没有这么一轮。
    pub fn record(&self, action: impl FnOnce(&mut Recorder)) -> bool {
        match self.current.lock() {
            Ok(mut current) => match current.as_mut() {
                Some(recorder) => {
                    action(recorder);

                    true
                }
                None => false,
            },
            // 锁坏了说明别的任务 panic 了。协议处理器没有什么关于这件事可以
            // 告诉 agent，所以这一帧被丢掉，失败由驱动那侧已经握着的那个报。
            Err(_poisoned) => false,
        }
    }

    /// 此刻有没有一轮在飞。
    pub fn is_listening(&self) -> bool {
        self.current.lock().is_ok_and(|current| current.is_some())
    }
}
