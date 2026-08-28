# @poietica/contract

我是什么：跨进程契约的唯一生成物，由 tauri-specta 从 Rust 类型导出。
我拥有什么：src/generated/ipc-bindings.ts，以及它的根入口。
谁允许调用我：任何环。
我不许知道什么：领域、特性、界面，以及任何手写的原生 DTO —— 我这里的每一行都由 cargo run -p poietica --bin export-ipc-bindings 产出。
