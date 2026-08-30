# kap-client

- **我是什么**：KAP 协议适配层：生成的协议模型、子进程与链路、会话与帧。
- **我拥有什么**：`generated/`（自 contracts/kap 快照生成，禁手改）；进程的定位、
  起停与实例注册表（process/）；拨号、握手与重连（connection/）；REST 调用面、
  投递协调与事件路由（session/）；帧的形状与翻译（frame.rs、translate.rs）；
  审批与提问两张桌子（interaction/）。
- **谁允许调用我**：组合根（src-tauri）与领域 crate 的 port 实现方。
- **我不许知道**：账本、UI、Tauri —— 帧交 FrameSink，落库由收帧侧做；会话裁决
  归 conversation，这里只翻译不裁决。
