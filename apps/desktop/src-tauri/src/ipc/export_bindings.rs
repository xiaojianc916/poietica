//! 构建期把 IPC 面导出成 `TypeScript`。
//!
//! 命令与 DTO 的清单不在这里，在 `super::surface` —— 运行期的 `invoke_handler`
//! 读的是同一份。这个文件只回答一个问题：写到哪。

use specta_typescript::Typescript;

const OUTPUT_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packages/contract/src/generated/ipc-bindings.ts"
);

/// 导出渲染层消费的那一份 IPC DTO 面。
///
/// 只由专用的 `export-ipc-bindings` 可执行文件调用，绝不在桌面应用启动时调用。
///
/// # Panics
///
/// 写不出绑定时 panic。那是构建故障而不是运行期状况，构建必须停在这里 ——
/// 静默失败的结果是发布一份过时的 IPC 面。
#[allow(
    clippy::expect_used,
    reason = "a binding export that silently failed would ship a stale IPC surface"
)]
pub fn export_document_bindings() {
    super::surface()
        .export(Typescript::default(), OUTPUT_PATH)
        .expect("failed to export document IPC TypeScript bindings");
}
