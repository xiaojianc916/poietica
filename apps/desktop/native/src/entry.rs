//! NAPI 入口：Electron 主进程持有的那个对象。
//!
//! 这是组合根，所以它可以认识所有人（bootstrap、ipc），而**没有任何模块认识它** ——
//! 模块图里它是一条单行道。上一版把入口与传输放在同一个文件里，于是每个发事件的模块
//! 都要 import 这个文件，环就出来了。

use std::sync::Arc;
use std::sync::atomic::Ordering;

use napi_derive::napi;
use serde_json::Value;
use tokio::runtime::Handle;
use tokio::task;

use crate::transport::{HostPorts, Ports, Shared, enter, lock, remember};

/// 进程里只有一个宿主，它持有的是「这个应用」。
#[napi]
#[derive(Debug)]
pub struct NativeHost {
    shared: Arc<Shared>,
}

#[napi]
impl NativeHost {
    #[napi(constructor)]
    #[must_use]
    pub fn new() -> Self {
        let shared = Arc::new(Shared::default());
        remember(&shared);

        Self { shared }
    }

    /// 装上宿主回调。装之前发事件不会有接收者，所以主进程在创建窗口之前先调它。
    #[napi]
    pub fn attach(&self, ports: HostPorts) -> napi::Result<()> {
        *lock(&self.shared.ports) = Some(Ports::new(ports.emit)?);

        Ok(())
    }

    /// 原生侧此刻有没有命令在跑。主进程用它决定要不要提示用户稍等。
    #[napi(getter)]
    pub fn busy(&self) -> bool {
        self.shared.busy.load(Ordering::Acquire)
    }

    /// 走完一次启动：开库、恢复上回的现场。幂等，第二次调用直接返回。
    #[napi]
    pub async fn start(&self, paths: crate::paths::HostPaths) -> napi::Result<()> {
        if self.shared.started.swap(true, Ordering::AcqRel) {
            return Ok(());
        }

        // 开库是阻塞的（SQLite 句柄 + 两个后台 actor 线程），在 tokio worker 上直接跑会
        // 触发 "Cannot block the current thread from within a runtime"。启动只发生一次，
        // 放进阻塞线程池既不占 worker 也不阻塞 JS 线程。
        let handle = Handle::current();
        task::spawn_blocking(move || crate::bootstrap::install(paths, &handle))
            .await
            .map_err(|error| napi::Error::from_reason(error.to_string()))?
            .map_err(|error| napi::Error::from_reason(error.to_string()))
    }

    /// 退出前把持有的东西放掉：会话连接、调度器、git 监视。
    /// 同步：退出屏障里没有 await，而它是最后一道 —— 让它跑完再交还控制权。
    #[napi]
    pub fn shutdown(&self) -> napi::Result<()> {
        crate::shutdown::run();

        Ok(())
    }

    /// 一条命令：名字加参数的 JSON 文本，回结算后的信封。
    #[napi]
    pub async fn invoke(&self, command: String, args_json: String) -> napi::Result<String> {
        let _ticket = enter()?;
        let args: Value = serde_json::from_str(&args_json).map_err(|error| {
            napi::Error::from_reason(format!("arguments were not JSON: {error}"))
        })?;

        crate::ipc::submit(&command, args).await
    }
}

impl Default for NativeHost {
    fn default() -> Self {
        Self::new()
    }
}
