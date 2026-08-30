# kap-client

- **我是什么**：KAP 协议适配层，协议形状的唯一 Rust 消费面。
- **我拥有什么**：`generated/`（自 contracts/kap 快照生成，禁手改）、控制帧与 REST
  应答的解码判据、信封语义（code/msg/data）。
- **谁允许调用我**：R2 适配环与组合根（agent-runtime 的传输引擎、未来的 translate 层）。
- **我不许知道**：账本、会话领域裁决、UI、Tauri —— 这里只认协议字节。
