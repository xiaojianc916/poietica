//! Poietica 的原生组合根：Electron 主进程通过 NAPI 直接调用这里。
//!
//! 进程里只有一个宿主，它持有的东西对应「这个应用」：账本、设置、agent 会话运行时、
//! 调度器。命令面是 ipc::surface，类型是各模块自己的 DTO，绑定由 export_bindings 导出。

pub mod agent;
pub mod asset;
pub mod automation;
mod bootstrap;
pub mod conversation;
mod entry;
pub mod error;
pub mod extension;
pub mod ipc;
pub mod transport;

pub use entry::NativeHost;
pub mod launcher;
pub mod ledger;
pub mod paths;
pub mod review;
pub mod settings;
pub mod shutdown;
pub mod skills;
pub mod terminal;
pub mod workspace;

pub use error::{Error, Result};

use napi_derive::napi;
use serde_json::Value;

/// 接管 tokio 运行时：所有命令共享同一个多线程 runtime。
///
/// napi-rs 默认自己建一个，这里显式建是为了给它起名 —— 线程名会出现在崩溃转储与采样器
/// 里，一堆无名的 tokio worker 让「主进程被谁占住了」这个问题无从回答。
#[napi_derive::module_init]
fn prepare() {
    match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("poietica")
        .build()
    {
        Ok(runtime) => napi::bindgen_prelude::create_custom_tokio_runtime(runtime),
        // 没有 logger 可用：这一步发生在任何初始化之前，事件循环还没开始。
        #[allow(clippy::print_stderr, reason = "logger 尚未初始化，stderr 是唯一出口")]
        Err(error) => eprintln!("the native tokio runtime was not created: {error}"),
    }
}

/// 命令面的形状检查：生成 TypeScript 绑定前先跑一次，任何一条命令的类型没能登记
/// 就在这里炸，而不是等用户装上以后在某个页面上报错。
#[napi]
pub fn contract_function_count() -> u32 {
    u32::try_from(ipc::functions().len()).unwrap_or(u32::MAX)
}

/// 一个 JSON 值原样过一遍边界。自检用它确认 serde-json 那条路是通的。
#[napi]
pub fn echo(value: Value) -> Value {
    value
}

/// 把命令面的类型导出成 TypeScript。只由专用的导出可执行文件调用，绝不在应用启动时调用。
///
/// i64 导出为 number 以不超 2^53 为前提；出现更大的计数字段时改回 Fail，由 DTO 边界收窄。
pub fn export_ipc_bindings() -> std::result::Result<std::path::PathBuf, String> {
    use specta_typescript::{BigIntExportBehavior, Typescript};

    let path = std::path::Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../packages/contract/src/generated/ipc-bindings.ts"
    ));

    export_bindings::write(
        path,
        &Typescript::default().bigint(BigIntExportBehavior::Number),
    )?;

    Ok(path.to_path_buf())
}

mod export_bindings;
