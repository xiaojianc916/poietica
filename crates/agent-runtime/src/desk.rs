use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use futures::channel::oneshot;

use crate::error::{KapError, Result};
use crate::permission::{Decision, kap_answers};

const UNKNOWN_REQUEST: &str = "that permission request is not outstanding";
const UNKNOWN_OPTION: &str = "that option was never offered for this permission request";
const HANDLER_GONE: &str = "the agent stopped waiting for that permission request";

/// One request the agent is blocked on.
#[derive(Debug)]
struct Waiting {
    /// The answers the user is allowed to give, by option identifier.
    allowed: HashMap<String, Decision>,
    /// Where the answer is delivered.
    answer: oneshot::Sender<Decision>,
}

/// The permission requests waiting for a human.
///
/// The protocol handler and the interface never meet: the handler is inside a
/// connection that was built once, and the answer arrives later on a command.
/// The desk is the only thing they share, and it holds nothing but the promise
/// of an answer.
#[derive(Clone, Debug, Default)]
pub struct PermissionDesk {
    outstanding: Arc<Mutex<HashMap<String, Waiting>>>,
}

impl PermissionDesk {
    /// An empty desk.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a kap approval and hands back the answer to await.
    ///
    /// kap 的审批请求不带选项，合法答复集是固定的三条（见 permission.rs），
    /// 所以等一个审批只要它的 approval_id。
    ///
    /// # Errors
    ///
    /// Fails when the desk was left locked by a panicking task.
    pub fn wait_kap(&self, approval_id: &str) -> Result<oneshot::Receiver<Decision>> {
        let (answer, waiting) = oneshot::channel();

        let _replaced = self.lock()?.insert(
            approval_id.to_owned(),
            Waiting {
                allowed: kap_answers(),
                answer,
            },
        );

        Ok(waiting)
    }

    /// Answers an outstanding request on the user's behalf.
    ///
    /// The answer is checked before the request is taken off the desk, so a
    /// nonsensical answer cannot destroy a request that is still legitimately
    /// waiting for a real one.
    ///
    /// # Errors
    ///
    /// Fails when the request is not outstanding, when the option was never
    /// offered, or when the agent has already stopped waiting.
    pub fn answer(&self, request_id: &str, option_id: &str) -> Result<()> {
        let mut outstanding = self.lock()?;

        let Some(waiting) = outstanding.get(request_id) else {
            return Err(refused(UNKNOWN_REQUEST));
        };

        let Some(decision) = waiting.allowed.get(option_id).cloned() else {
            return Err(refused(UNKNOWN_OPTION));
        };

        let Some(waiting) = outstanding.remove(request_id) else {
            return Err(refused(UNKNOWN_REQUEST));
        };

        waiting
            .answer
            .send(decision)
            .map_err(|_gone| refused(HANDLER_GONE))
    }

    /// Abandons the requests these identifiers name.
    ///
    /// 一轮结束时要放掉的正是它自己开着的那些，而且只有那些。整张桌子清空
    /// 是「一条连接只可能有一轮」时代的写法：几轮同时在飞时，它会替别的会话
    /// 把它正等着人回答的问题也一并取消掉。
    pub fn abandon(&self, request_ids: &[String]) {
        if let Ok(mut outstanding) = self.outstanding.lock() {
            for request_id in request_ids {
                let _abandoned = outstanding.remove(request_id);
            }
        }
    }

    /// Abandons every outstanding request.
    ///
    /// 整条连接要走了才用得上：那时确实没有人会再来回答任何一个问题。
    pub fn clear(&self) {
        if let Ok(mut outstanding) = self.outstanding.lock() {
            outstanding.clear();
        }
    }

    /// How many requests are waiting for an answer.
    #[must_use]
    pub fn waiting(&self) -> usize {
        self.outstanding
            .lock()
            .map_or(0, |outstanding| outstanding.len())
    }

    fn lock(&self) -> Result<MutexGuard<'_, HashMap<String, Waiting>>> {
        self.outstanding
            .lock()
            .map_err(|_poisoned| KapError::Poisoned)
    }
}

fn refused(message: &str) -> KapError {
    KapError::Permission {
        message: message.to_owned(),
    }
}
