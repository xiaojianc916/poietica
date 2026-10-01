//! 原生能力的传输层：Electron 主进程是唯一宿主，渲染层是唯一消费者。
//!
//! 一条请求的形状固定为 { command, argsJson }，一条应答的形状固定为 { ok } 或
//! { error }（见 settle）。命令面由 super::surface 收集，生成的 TypeScript 门面照它
//! 一个不多一个不少 —— 手抄第二份命令表就是这个仓库定义过的缺陷。
//!
//! 这里做的三件事都只跟跨语言有关，不含任何业务：
//! 1. 忙闸：同一时刻只放一条命令进原生侧。原生侧持有的账本、会话与浏览器表是
//!    单写者的，放两条进来就要在每个结构里各写一套并发裁决。
//! 2. 结算：把领域错误换成线上信封，失败不冒充成功。
//! 3. 推事件：终端输出、agent 会话事件要主动送到渲染层。
//!
//! 载荷一律走 JSON 文本，不走 napi 的结构化转换：命令面有七十多条、参数有七十多个
//! 已有 serde 定义的类型，为它们逐个补一份 napi 镜像类型就是给同一件事建第二个事实。

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use napi::Status;
use napi::bindgen_prelude::Function;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use serde_json::{Value, json};

/// 宿主装一次的回调。只有 JS 才知道答案的事情才放进来：往哪个渲染进程送事件。
#[napi(object)]
pub struct HostPorts {
    pub emit: Function<'static, String, ()>,
}

/// 手写 Debug：`Function` 是一个 JS 引用，打出来没有意义。
impl std::fmt::Debug for HostPorts {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("HostPorts").finish_non_exhaustive()
    }
}

/// 手写 Debug：`Ports` 里是一个跨线程函数引用，打出来没有意义。
#[derive(Default)]
pub struct Shared {
    pub(crate) busy: AtomicUsize,
    pub(crate) ports: Mutex<Option<Ports>>,
    pub(crate) started: AtomicBool,
}

impl std::fmt::Debug for Shared {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Shared")
            .field("busy", &self.busy)
            .field("started", &self.started)
            .finish_non_exhaustive()
    }
}

/// 进程里只有一个宿主，所以读的是一个槽，不是一张表。
static CURRENT: Mutex<Option<Arc<Shared>>> = Mutex::new(None);

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub(crate) fn remember(shared: &Arc<Shared>) {
    *lock(&CURRENT) = Some(Arc::clone(shared));
}

fn current() -> napi::Result<Arc<Shared>> {
    lock(&CURRENT)
        .clone()
        .ok_or_else(|| napi::Error::from_reason("the native host is not constructed"))
}

/// 记一次进原生侧的开始与结束。
///
/// **不拒绝并发的调用。** 早先这里是一道「一次只放一条」的闸，忙就当场报错；它把
/// 渲染层启动时那十几条同时发出的读（设置、会话、控件表）全部打成失败，界面上表现为
/// 「连不上 agent」。命令面的并发本来就是允许的 —— 账本那两个 actor 线程、会话运行
/// 时自己那把锁，各自都在它该在的层次上裁决，宿主不该在这里替它们做串行化。
///
/// 保留的只是一个计数：`busy` 是给界面看的（有活在跑就显示忙），不是准入许可。
pub struct Running {
    shared: Arc<Shared>,
}

impl std::fmt::Debug for Running {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("Running").finish_non_exhaustive()
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        self.shared.busy.fetch_sub(1, Ordering::AcqRel);
    }
}

/// 记一次开始。返回值活着期间算「有活在跑」——`Running` 本身是 `#[must_use]`。
pub fn running() -> napi::Result<Running> {
    let shared = current()?;

    shared.busy.fetch_add(1, Ordering::AcqRel);

    Ok(Running { shared })
}

/// 把一次命令的领域结果结算成线上应答。
///
/// 成功与失败用不同的键，不靠「有没有 error 字段」猜：调用方拿到的一定是二者之一。
/// 进这里的已经是序列化后的值：序列化在 ipc::submit 的 encode 里做，那里是唯一知道
/// 每条命令返回什么的地方，这里只负责信封。
pub fn settle(outcome: Result<Value, poietica_problem::Problem>) -> napi::Result<String> {
    let envelope = match outcome {
        Ok(value) => json!({ "ok": value }),
        Err(problem) => json!({ "error": problem }),
    };

    Ok(serde_json::to_string(&envelope)?)
}

/// 把一次命令的入参从 JSON 里读出来。
///
/// 渲染层送的是结构化对象，但边界上只承诺一个 JSON 值：具体形状由每条命令自己的请求
/// 类型裁决，这里只负责解不开时报出是哪一条命令解不开。
pub fn argument<T: serde::de::DeserializeOwned>(raw: &Value) -> napi::Result<T> {
    serde_json::from_value(raw.clone())
        .map_err(|error| napi::Error::from_reason(format!("arguments did not match: {error}")))
}

/// 往渲染层推一个事件。没有接收者时静默丢弃：事件是「此刻发生的事」，补发一条过期的
/// 事件比丢掉它更糟。
pub fn emit(kind: &str, payload: &Value) {
    let Some(shared) = lock(&CURRENT).clone() else {
        return;
    };
    let call = lock(&shared.ports).as_ref().map(Ports::callback);

    if let Some(call) = call {
        let frame = json!({ "kind": kind, "payload": payload }).to_string();

        if call.call(frame, ThreadsafeFunctionCallMode::NonBlocking) != Status::Ok {
            log::warn!("event {kind} was not delivered");
        }
    }
}

/// 宿主回调的持有形态。
///
/// 不用 FunctionRef：那个引用只能在装它的那个 JS 线程上调用，而事件的生产者在
/// tokio 工作线程上。ThreadsafeFunction 才是为跨线程调用准备的。
pub(crate) struct Ports {
    emit: Arc<ThreadsafeFunction<String, (), String, Status, false, true>>,
}

impl Ports {
    #[allow(
        clippy::needless_pass_by_value,
        reason = "build_threadsafe_function 消费 self，Function 必须按值收下"
    )]
    pub(crate) fn new(emit: Function<'static, String, ()>) -> napi::Result<Self> {
        Ok(Self {
            emit: Arc::new(
                emit.build_threadsafe_function()
                    .callee_handled::<false>()
                    // weak：事件回调不能吊住宿主的事件循环，否则窗口关了进程也不退。
                    .weak::<true>()
                    .build()?,
            ),
        })
    }

    fn callback(&self) -> Arc<ThreadsafeFunction<String, (), String, Status, false, true>> {
        Arc::clone(&self.emit)
    }
}
