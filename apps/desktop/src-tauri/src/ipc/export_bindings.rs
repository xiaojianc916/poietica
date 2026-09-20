//! 构建期把 IPC 面导出成 `TypeScript`；命令与 DTO 的清单在 `super::surface`，这里只管写到哪。

use specta_typescript::{BigIntExportBehavior, Typescript};

const OUTPUT_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packages/contract/src/generated/ipc-bindings.ts"
);

/// 只由专用的 `export-ipc-bindings` 可执行文件调用，绝不在应用启动时调用。
/// i64 导出为 `number` 以不超 2^53 为前提；出现更大的计数字段时改回 Fail，由 DTO 边界收窄。
#[allow(
    clippy::expect_used,
    reason = "a binding export that silently failed would ship a stale IPC surface"
)]
pub fn export_ipc_bindings() {
    super::surface()
        .export(
            Typescript::default().bigint(BigIntExportBehavior::Number),
            OUTPUT_PATH,
        )
        .expect("failed to export document IPC TypeScript bindings");
}
