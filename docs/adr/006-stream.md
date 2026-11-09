# ADR-006：流原语与主题路由

状态：通过（P2 目标，实施中）。

- 新增 `stream-kit`：快照 + 增量 + epoch + seq + 补齐 + 背压 + 取消的统一语义；时间线、终端、浏览器标签、线程列表与运行状态都迁到它上，不再各写一套流协议。
- 服务端按主题（threadId + agentId、terminalId、tabId 等）维护环形缓冲；客户端带 epoch/seq 订阅，断号先补齐，补不齐取快照。
- Host 的 RpcHub 维护「窗口 → 已订阅主题」，流增量只发给订阅者；普通通知仍广播。Host 只读信封里的主题键，不解析载荷。
- 窗口重载清除订阅；Core 重启换 epoch，UI 在 `onCoreReady` 统一重新订阅。
- P1 的 `timeline.events` 是过渡形状（单通道、16ms 合批、无通用背压）；本 ADR 在 P2 把它们收进 stream-kit，并建立 UI–Core 直连数据面。

## 实施进度（2026-11-08）

- 已落地 `packages/stream-kit`：通用 `StreamChannel<T>`（合批、seq、epoch、环形缓冲、补发、coalesce）与测试。
- conversation 的 `TimelineChannel` 已改用它，工具中间结果节流留在时间线层。
- 尚未落地：Host 主题路由、UI–Core 直连数据面、终端/浏览器迁移到同一原语、通用背压降级。
- Host 的 `RpcHub` 已按 `(threadId, agentId)` 记录窗口订阅，`timeline.events` / `timeline.reset` 只发给订阅窗口；窗口重载清除订阅。普通通知仍广播。
- 补发/重连已由集成用例钉住：断线期间跑完的轮次经 `timeline.catchUp` 按 seq 连续补发，重新 subscribe 的快照 turnId 不重复。

## 迁移状态

- 时间线：`TimelineChannel`（stream-kit），主题 `(threadId, agentId)`；`timeline.subscribe/page/catchUp`。
- 终端输出：Host 每个终端一个 `StreamChannel`（8ms 合批），通知带 `epoch/seq`，`terminal.catchUp` 补发；`offset` 保留给 xterm 对齐，`terminal.replay` 返回 `epoch/seq`。
- 侧边提问：`SideTopicHub` 每个 `(threadId, topicId)` 一个 `StreamChannel`，通知带 `epoch/seq`，`side.catchUp` 补发；`offset` 保留给现有追加逻辑。
- UI ↔ Core 直连：按方案 §3.3，默认不启用；先测量数据面延迟，未达 G11 再开。控制面仍走 Host。
