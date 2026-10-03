# 0035. 接上 omp 的工具流与技能展开：官方给的两条通道，从前被静默丢掉

- 状态：已接受
- 日期：2026-10-03
- 归属：agent-bridge / conversation / asset

## 背景

一次以 Chrome-DevTools MCP 驱动真实宿主的三阶段审查（只读 → 全新子代理交叉复核 → 编辑实测）
查出两处"官方能力就在链上、只有最后一跳没接"，以及一处"取字节的形状让 Range 请求付整份的价"。
三者都是**静默**的：屏幕上看不出少了什么，只有对照官方源码与实测才认得出来。

### 一、工具的中间结果整条丢弃

官方为宿主专门发了两条事件（`pi-agent-core/src/agent-loop.ts:3208-3222` 与 `:2101-2115`）：

- `tool_execution_update` 带 `partialResult`，13 处工具在产（bash 的 tail 按 **50ms** 节流、
  eval、glob、wait、gh-run-watch…）；
- `tool_stream_update` 带 `update`，edit 的实时 diff 走它。

本仓 `bridge.ts` 的 `handleEvent` 没有这两个 case，落进 `default: break` **静默丢弃**
（全仓 0 命中）。后果：一条跑三分钟的 bash 在屏幕上从「运行中」直接跳到终态。

### 二、`prompt.skills` 全链透传，只有桥丢了

`protocol.ts` → `wire.rs` → `frame.rs` → `admission.rs` → `gateway.rs` 一路都在，
而桥全文没有一处读 `command.skills`（grep = 0）。官方 `AgentSession.prompt()`
**自己不解析** `/skill:` —— 全包只有 CLI / RPC / ACP / task 四处调 `parseSkillInvocation`，
而它们都走 `promptCustomMessage`。于是技能根本没执行，而屏幕那一半同样可疑：
`skillNamesOf` 只读 `turn.origin.payload.skillActivations`，该字段**全仓无生产者**。

### 三、取字节"先全量、后切片"

`asset_read` 没有 offset/length → 注册表交整份 → 主进程 `asset-protocol.ts` 先取整份、
在协议应答里才切。实测 4.2 MB 资产取 1 KiB 要 **151 ms**，取整份才 171 ms —— 只差 12%。

## 决策

**三处都走官方形状，不自造第二套。**

1. **工具流**：桥接上那两条事件，投影器加 `toolUpdate`，写同一 `frameId` 的 `frame.upsert`
   （整格替换，`state` 仍是 `running`，入参照旧带回）。**不改 transcript schema** ——
   `toolCallFrameSchema` 本来就有 `output`。

2. **技能**：桥调官方的 `buildSkillPromptMessage`（读 SKILL.md、剥 frontmatter、渲染它自己的
   `userInvocationTemplate`）→ `promptCustomMessage` 带 `SKILL_PROMPT_MESSAGE_TYPE`，
   照抄官方 RPC 宿主那 17 行（`modes/rpc/rpc-mode.ts:157-174`）。**不自己读盘、不自己发明格式**
   —— 模板是上游的、会变。名字对不上会话自己的技能表时**报错**，不静默。
   屏幕那一半同时接对：技能写进 `turn.origin.payload.skillActivations`，chip 才画得出来。
   插话（steer / followUp）那条路同样展开，并用 `queueChipText` 让队列 chip 显示用户原话。

3. **资产字节**：`asset_read` 加 `offset`/`length`，**切片发生在原生侧编码之前**；
   应答多回一个 `totalLength`（Range 应答要拿它拼 `content-range`）。
   协议处理器把 Range 解析提到取字节之前，只把要的区间传下去。

## 后果

- 长工具在屏幕上有中间态了；edit 的实时 diff、eval 的增量输出可见。
- `/skill:` 真正执行；chip 有真产地。
- Range 请求的代价从「整份」降到「这一段」：实测 **151.3 ms → 2.8 ms（54×）**，
  整份那条路不变。后缀式 `bytes=-N` 仍需总长，刻意退化成老行为（浏览器基本不发它）。
- `asset_read` 的线上形状多两格、`AssetReadResult` 多一格，生成绑定同一次重生成。
- 未接的仍在册：`Command::Shutdown` 零构造方（退出不调官方 `dispose()`）、
  token 口径缺官方算好的 `cost`/`reasoning`。两者都要产品决策，本轮只登记不改。

## 相关代码

- 桥：`packages/agent-bridge/src/{bridge.ts,projection.ts,protocol.ts}`
- 屏幕：`packages/conversation/src/transcript/transcript-projector.ts`（origin 与 chip）
- 资产：`apps/desktop/native/src/asset.rs`、`crates/asset/src/registry.rs`、
  `apps/desktop/electron/{asset-protocol.ts,main.ts}`、`packages/native-bridge/src/asset/transfer.ts`
- SDK 锚点（18.3.0）：`pi-agent-core/src/agent-loop.ts:3208/2101`、
  `extensibility/skills.ts:450/482`、`modes/rpc/rpc-mode.ts:141-174`、
  `session/messages.d.ts`（`SKILL_PROMPT_MESSAGE_TYPE`）
