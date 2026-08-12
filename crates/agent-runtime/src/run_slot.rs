use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::v1::SessionNotification;

use crate::error::{AcpError, Refusal, Result};
use crate::recorder::{Frames, Recorder, SeqLine};

/// 此刻在这条会话上听着的是谁。
///
/// 两种，因为一条会话上确实会发生两件不同的事。
///
/// 一轮在飞时听的是记录器：帧除了成形交出去，还要喂这一轮自己的工作内存
/// —— 哪些权限问答没落定、每个工具调用叫什么、这一轮有没有失败。而
/// `session/load` 期间 agent 把整条会话重放一遍，那些帧的持有者是 agent
/// 自己 —— 它们只要成形和投递，一轮的工作内存对它们没有意义。
#[derive(Debug)]
pub enum Listening {
    /// 一轮正在飞。
    Turn(Recorder),
    /// 一条旧会话正被装载回来。
    Replay(Frames),
}

impl Listening {
    /// 一帧会话通知，按此刻听着的那一位的办法处理。
    ///
    /// 接收路径上只有这一个分发点。
    pub fn session_update(&mut self, notification: &SessionNotification) {
        match self {
            Self::Turn(recorder) => recorder.record_session_update(notification),
            /* 成形失败在实时那一侧会记成这一轮的失败；这里没有一轮可以失败，
            所以它表现为历史里少一帧。序列化的是 SDK 自己的类型，走到这一步
            意味着协议库自身出了问题。 */
            Self::Replay(frames) => {
                let _unencodable = frames.record_session_update(notification);
            }
        }
    }

    /// 正在飞的那一轮，如果此刻飞的是一轮。
    ///
    /// 权限问答只在一轮里成立：装载期间 agent 不会问，问了也没人答。此前这
    /// 件事靠「槽里恰好是记录器」这个巧合成立，现在写下来。
    pub const fn turn_mut(&mut self) -> Option<&mut Recorder> {
        match self {
            Self::Turn(recorder) => Some(recorder),
            Self::Replay(_frames) => None,
        }
    }
}

/// 到达的会话更新交给谁。
///
/// 协议处理器装一次，管整条连接。一个听众只活它自己那件事那么久。两个寿命
/// 对不上，所以处理器不拥有听众，它们隔着这个槽相见。
///
/// 没人在听时到达的更新被丢掉，而不是记到恰好排在它前面的那件事头上。
#[derive(Clone, Debug, Default)]
pub struct RunSlot {
    current: Arc<Mutex<Option<Listening>>>,
    /// 这条会话的序号线。它比任何一位听众都活得久，所以位置的家在这里。
    seq: SeqLine,
}

impl RunSlot {
    /// 一个空槽，没人在听。
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// 这条会话的序号线。听众换人，位置接着数。
    #[must_use]
    pub fn seq(&self) -> SeqLine {
        self.seq.clone()
    }

    /// 让这一位来听接下来的更新。
    ///
    /// # Errors
    ///
    /// 已经有人在听时报错 —— 一条会话上的第二轮就是这么被拒的；锁坏了也报错。
    pub fn install(&self, listening: Listening) -> Result<()> {
        let mut current = self
            .current
            .lock()
            .map_err(|_poisoned| AcpError::Poisoned)?;

        if current.is_some() {
            return Err(AcpError::Refused(Refusal::Busy));
        }

        *current = Some(listening);

        Ok(())
    }

    /// 不听了，把这一位交回去，好让它自己收尾。
    ///
    /// # Errors
    ///
    /// 锁坏了时报错。
    pub fn take(&self) -> Result<Option<Listening>> {
        let mut current = self
            .current
            .lock()
            .map_err(|_poisoned| AcpError::Poisoned)?;

        Ok(current.take())
    }

    /// 对此刻在听的那一位做一件事，并交代有没有人在听。
    pub fn record(&self, action: impl FnOnce(&mut Listening)) -> bool {
        match self.current.lock() {
            Ok(mut current) => match current.as_mut() {
                Some(listening) => {
                    action(listening);

                    true
                }
                None => false,
            },
            // 锁坏了说明别的任务 panic 了。协议处理器没有什么关于这件事可以
            // 告诉 agent，所以这一帧被丢掉，失败由驱动那侧已经握着的那个报。
            Err(_poisoned) => false,
        }
    }

    /// 此刻有没有人在听。
    ///
    /// 不问是谁：一轮在飞和一条会话正被装载，对「这一帧有没有去处」是同一个答案。
    pub fn is_listening(&self) -> bool {
        self.current.lock().is_ok_and(|current| current.is_some())
    }
}
