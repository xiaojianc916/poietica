# agent-client

- **我是什么**：agent 传输适配层：起随包发的边车、在 stdio 上说 NDJSON、会话与帧。
  唯一接的 agent 是 oh-my-pi，它由 `packages/agent-bridge` 编成一个可执行文件随包
  发出（ADR 0052）——用户不装任何 CLI。
- **我拥有什么**：线上形状（`wire.rs`，与 `packages/agent-bridge/src/protocol.ts`
  逐字对应）；进程的定位、起停与受控 home（process/）；命令与应答的配对、事件派发
  （session/bridge.rs）；帧的形状与翻译（frame.rs、translate.rs）；审批与提问两张
  桌子（interaction/）。
- **谁允许调用我**：组合根（src-tauri）与领域 crate 的 port 实现方。
- **我不许知道**：账本、UI、Tauri —— 帧交 FrameSink，落库由收帧侧做；会话裁决
  归 conversation，这里只翻译不裁决。协议类型也不许手抄：桥那边改名，这里同一次
  改完，否则 serde 会把帧静默丢成 None。
