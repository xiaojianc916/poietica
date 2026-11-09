# ADR-002：产品模型与事实归属

状态：通过（P0）。

产品拥有 thread、工作区、操作与产品事件；omp 拥有运行时行为和会话正文。派生投影不能成为另一份独立事实。P1 建立产品事件模型与单一 normalizer，P2 引入 Journal 和可重建索引；P0 不声称这些已完成。这样减少双投影和多处解释的漂移。

## P1 实施记录（2026-11-08）

- `packages/transcript` 更名为 `packages/agent-model`，AgentEvent 信封、事件目录与唯一 `ThreadReducer` 落在该包；`snapshotOf` / `stateFromSnapshot` / `reduceAllChecked` 是 Core 快照与 UI 副本共用的 fold。
- engine-omp 的实时与历史两条投影都改为产出 AgentEvent；`OpenTurnScreen` 与「开轮屏」对拍删除，开着的一轮由实时 fold 合入整页。
- Core 的时间线通知改为 `timeline.events`；UI 的 `TranscriptReplica` 直接使用 ThreadReducer。
- `packages/engine` 收敛为 `packages/runtime-protocol`：它仍是 omp 形状的进程内契约，P3 再换成 ARP；这一步只删除假平台包名，不声称 ARP 已完成。
- 工具载荷按工具名收口到 `omp-types`：`ToolCallFrame.input/output` 是带 generic 兜底的 typed union，时间线卡片的每格处理器直接拿到自己那个工具的入参与 details；`tool-payload-parsing` 在 `features/conversation` 的工具视图里已归零。
- Core 模块不再拿到完整引擎对象：`ctx.engine` 删除，改为 `ctx.agentRuntime` 的按能力分组（sessions / models / settings / skills / mcp / plugins / browser）。conversation 只拿到「会话 + 模型 + 设置」的扁平窄面，automations 只拿到 draftControls，extensions 只拿到三个扩展端口。进程边界（ARP）仍属 P3。
- 尚未完成：`timeline.ops` 的旧命名在测试与领域代码里仍有历史注释；浏览器之外的 `tool-payload-parsing` 计数仍挂在 extensions / intelligent-ui / ui-kernel 等非工具载荷上，P1 不把它们算作工具卡片验收。
