# AI activity feed

Feed 是投影，不是真相。

    transcript ops/reset  ->  transcript-store  ->  projectTranscript  ->  timeline  ->  selectors  ->  feed rows

每一步都成立的规则：

- 投影是纯的、可回放的。渲染持久化 run 与观看 live run 走同一条代码路径：
  增量 ops 与 reset 快照落到同一条 timeline（见
  `tests/integration/transcript-replay-equivalence.test.ts`）。
- 条目按类型区分，不按角色。工具调用以其 tool call id 可寻址，因为协议按 id
  更新它。
- Feed 宿主只拥有滚动与测量。条目渲染是注入的，条目设计变动不触动虚拟化。
- Stick-to-bottom 跟随用户意图：读者一旦向上滚，流式 run 不得把他们拽回来。

条目渲染当前落在 `packages/conversation/src/surface/feed`。设计原语来自
`@poietica/design-system`，禁自建 dialog/menu/tooltip/select/combobox/toast
交互内核（见 [UI authority](./ui-authority-boundaries.md)）。
