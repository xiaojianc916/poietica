# @poietica/contract

我是什么：跨进程契约的唯一生成物，由 tauri-specta 从 Rust 类型导出，外加一层按领域切片的类型转发。
我拥有什么：src/generated/ipc-bindings.ts（生成，禁手改），以及 src/*.ts 那六个只转发类型的子路径入口。
谁允许调用我：任何环，但领域包只能经自己那一片子路径拿到 type-only 的边（DOMAIN_CONTRACT_IMPORTS）。
我不许知道什么：领域、特性、界面，以及任何手写的原生 DTO。生成物里每一行都由 cargo run -p poietica --bin export-ipc-bindings 产出；子路径入口只许转发，不许声明新形状、不许引入运行时值（contract-shims-stay-generated）。
