//! 这台机器上那一个本地索引库。
//!
//! 库归应用，不归任何一个子系统。store.rs 写着「A single writer is
//! intentional.」，而此前那个唯一写者挂在 AgentRuntime 上，取用它的四个
//! helper 都是 pub(super) —— 那句话因此只对 commands::agent 成立：第二个
//! 子系统要用同一个库，除了再开一条连接没有别的路，而再开一条连接正是那句
//! 话要禁止的事。库住在这里之后，那句话对整个进程成立。
//!
//! 迁移在窗口出现之前跑完（bootstrap/app.rs 的 setup），所以每一条命令拿到
//! 的都是一个已经就绪的库，没有哪一次调用需要为「第一次」付钱。

use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

use poietica_agent_persistence_native::{AgentStore, StoreError};
use tauri::{State, async_runtime};
use uuid::Uuid;

use crate::error::{Error, Result};

const POISONED: &str = "the index lock was left locked by a panicking task";
const NO_READ: &str = "the database read did not finish";

/// 库里的一个计数，大到线上那一格装不下。
///
/// 到不了：四十亿条用户消息，或者一句话里四十亿张图。但静默截断不能接受，
/// 所以它有一个说法。
const COUNT_TOO_LARGE: &str = "a stored count does not fit the wire";

/// 这台机器上那一个索引库，以及它唯一的写者。
#[derive(Debug)]
pub struct LocalIndex {
    store: Arc<Mutex<AgentStore>>,
}

impl LocalIndex {
    /// 打开库并把迁移跑完。
    ///
    /// 在 setup 里调用，不是第一次用到时才调用：工作台在第一帧之前就要读它，
    /// 库无论如何都会在启动时被打开。放在这里，前端那一次等待只是一条 SELECT，
    /// 而不是一次时长不可预测的迁移。
    ///
    /// # Errors
    ///
    /// 文件打不开、或某一条迁移被拒时返回错误。
    pub fn open(path: &Path) -> Result<Self> {
        Ok(Self {
            store: Arc::new(Mutex::new(AgentStore::open(path).map_err(persistence)?)),
        })
    }
}

/// 取那把锁，一条语句的功夫。
///
/// 绝不跨 await 持有：持有它的 future 不是 Send，而命令的 future 必须是。
fn borrow(shared: &Arc<Mutex<AgentStore>>) -> Result<MutexGuard<'_, AgentStore>> {
    shared
        .lock()
        .map_err(|_poisoned| Error::Internal(POISONED.to_owned()))
}

/// 读或写这个库，不站在主线程上。
///
/// 不是 async 的命令跑在主线程上，而一次读可能要等写锁，最长等满
/// DEFAULT_BUSY_TIMEOUT 才回来一行。放在主线程上，窗口在那段时间里停止应答：
/// 侧栏不高亮、点击不落地，看起来是坏了而不是慢。
///
/// 两半是分开的：拿句柄要借管理态，干活要 'static。
///
/// # Errors
///
/// 锁被毒化、线程池把这段活丢了、或者这段活自己失败时返回错误。
pub async fn on_index<T, F>(index: &State<'_, LocalIndex>, work: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&mut AgentStore) -> Result<T> + Send + 'static,
{
    let shared = Arc::clone(&index.store);

    async_runtime::spawn_blocking(move || {
        let mut store = borrow(&shared)?;

        work(&mut store)
    })
    .await
    .map_err(|_dropped| Error::Internal(NO_READ.to_owned()))?
}

/// 库说不行，说给上一层听的那一句。
pub fn persistence(error: StoreError) -> Error {
    Error::Persistence(error.to_string())
}

/// 库里的一个计数，缩成线上那一格。
///
/// 只有这一处做这件事。SQLite 交回来的一律是 i64，而这份 IPC 面上没有任何
/// 一个 64 位整数 —— 边界在这里，不在别处。
pub fn counted(value: i64) -> Result<u32> {
    u32::try_from(value).map_err(|_overflow| Error::Internal(COUNT_TOO_LARGE.to_owned()))
}

/// 读一个渲染层给过来的对话号。
pub fn conversation(named: &str) -> Result<Uuid> {
    Uuid::parse_str(named).map_err(|_invalid| {
        Error::Validation("the conversation identifier is not a UUID".to_owned())
    })
}
