# 0030 — 屏幕正文改用 omp 的显示经过：窗口化重投影与翻页现取

状态：accepted
日期：2026-10-02
触及：agent-bridge（屏幕经过的产地与分页）、@poietica/transcript（reducer 热路径）

## 背景

打开一条超大对话的实测（10 000 轮 / 42 MB，合成夹具，本机）：

| 环节 | 改前 |
| --- | --- |
| `load_session` | 6.9 s |
| 过桥字节 | 86.6 MB（20 000 帧） |
| 基线页 | 49.9 MB、8 485 轮 |
| 桥进程 RSS 增量 | +578 MB |

三条根因，全部有据：

1. **屏幕正文取自模型上下文**。`replayHistory` 回放 `agent.messages`，而它是
   「压缩摘要 + 保留的尾部」。重开一条压缩过的长对话，被压掉的历史直接从屏幕上消失，
   且 `before_turn` 也翻不回来 —— 内存里根本没有那些 ops。
2. **打开即全量回放**。一次 `load_session` 把整条会话投影成 ops 推给客户端，
   分页只是"先全量装入内存、再按字节开窗"。
3. **基线页预算等于传输上限**。`FRAME_BUDGET_BYTES = MAX_FRAME_BYTES - 64 KiB`
   （约 50 MiB，protocol.ts:620），一页就能是一整块 50 MB 的 IPC 帧。

## 决策

### A. 屏幕正文的产地改为 `buildSessionContext({ transcript: true })`

- `packages/agent-bridge/src/bridge.ts`：`replayHistory` 删除，换成
  `screenTurns`（读显示经过）+ `syncScreen`（把它铺到屏幕上）。
  `collapseCompactedHistory` 读 omp 自己那一格设置（`display.collapseCompacted`，官方
  默认 true = 与 TUI 的实时表面同档：折叠压缩前的历史、留一条分隔线；关掉则全历史内联，
  每个压缩点各一条线）。**两条路都不丢内容，也都说明了「这里发生过压缩」** —— 旧代码
  两条都没有：既没有分隔线，重开后的那段历史也不在显示经过里。
- 压缩落成 `markerOp`（`compaction-<轮号>`），位置就是它在显示经过里的位置；
  `packages/conversation` 已有的 `CompactionTimelineItem` 继续渲染它，无需改动。

### B. 屏幕只铺一个尾部窗口，更早的由翻页现取

- `SCREEN_WINDOW_ENTRIES = 40`：屏幕是窗口不是副本；更早的由 `warmScreen`
  按 `beforeTurn` 现投影（一次 64 格，只补镜像手上没有的更早段）。
- 页的预算与传输上限解耦：`PAGE_BUDGET_BYTES = 4 MiB`（`MAX_FRAME_BYTES` 只是"一行
  不许顶穿"的安全阀，不是页该多大）。页的 `has_more` 由 `floor`（显示经过的下界）判。
- 批次日志保留 `MAX_BATCHES = 512`：追赶成本只随断线时长变，不随会话总长变；
  超出窗口如实回 `complete: false`，客户端退回整页读法。

### C. reducer 的位置表不再整表重建

- `packages/transcript/src/ops/apply.ts`：`insertTurn` 在"追加到末尾"这一支上
  增量维护 `turnIndex`（乱序到达仍走全表）；`sealTurn` 不再重建整张表
  （就地改写不改位置）。

### D. 轮号跨进程稳定

屏幕上的轮号 = **这一格在显示经过里的位置**（不是"画出来的第几行"，那会随压缩挪位），
`TranscriptProjector.seat()` 把增量那条路的累加器摆到同一条坐标上；轮终的
`turnEnd` 带上这一格的位置，两条路于是落在同一格。

## 验收（同一夹具，实测）

| 判据 | 改前 | 改后 |
| --- | --- | --- |
| `load_session` | 6.9 s | 2.4 s |
| 过桥字节 | 86.6 MB | 0.14 MB |
| 基线页 | 49.9 MB / 8 485 轮 | 0.12 MB / 40 轮 |
| 翻页一页 | 8.9 MB | 204 KB（64 轮，不重叠） |
| 客户端解码+装入+投影+成帧 | 145 ms | 10 ms |
| 增量 reducer（4 000 轮 × 22 op） | 406 ms | 196 ms |
| 压缩前的历史 | 屏幕上看不到、也翻不回来 | `collapse` 后仍在显示经过里，可翻回 |

### E. 「重开等价」的实测（含压缩的那条会话）

一条 6 轮、在第 6 轮前压缩过一次的会话：

- 官方默认（`display.collapseCompacted: true`）：屏幕上 `第6问 → 第6答 → 压缩标记`；
- 关掉那一格：屏幕上 `第1问 … 第6答 → 压缩标记` **十二轮一条不少**。

两条路都说明了「这里发生过压缩」，也都不丢内容 —— 这正是旧代码缺的（旧代码屏幕上
只有 `第6问 → 第6答`，没有分隔线，被压掉的五轮既不在屏上也翻不回来）。

## 未做到 / 记录

- 客户端（`packages/conversation`）只消费 ops，本次未改；`transcript-replica` 的
  `#coverBoundary` 在页变小后的往返上限仍未设（本轮无回归，留待后续）。
- `read_media` 仍是 `Err(unwired)`（图片通道未接线，历史图片继续以 data URL 内联）；
  `takeWithinBudget` 丢弃附件仍不置 `has_more`。
- 屏幕窗口的"翻页翻上去的老历史"由客户端按轮号排序持有；桥侧窗口之上不再累积。
## 浏览器实测（chrome-devtools，真实页 JSON）

把桥交出来的两页真实 JSON 落盘后在浏览器里解码 + 装入（file:// 页面 + DevTools 协议）：

| 页 | 文件 | `JSON.parse` | zod 校验 | 轮数 | 首轮 | `has_more` |
| --- | --- | --- | --- | --- | --- | --- |
| 改后（4 MiB 页 / 窗口化） | 0.12 MB | 17 ms | <1 ms | 40 | 19961 | true |
| 改前（约 50 MiB 页 / 全量回放） | 49.94 MB | 146 ms | 2 ms | 8 485 | 1516 | true |

改后那一页是"最新 40 轮"（首轮 19961），改前那一页从第 1516 轮起 —— 打开一条 1 万轮的
会话，屏幕上先铺的就是这 8 485 轮里的内容；剩下的 8 515 轮在改前根本不在这一页里。