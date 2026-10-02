# Rust 侧审计（crates/**、apps/desktop/native/**）

范围：`crates/**`、`apps/desktop/native/**`。验证命令全绿：
`cargo fmt --all -- --check`（exit 0）、`bun run clippy`（-D warnings，exit 0）、
`bun run test:rust`（exit 0，0 failed；唯一 1 ignored 是下面那条自愿的测量用例）。

## 已修复

- **crates/asset/src/delivery.rs:6**（Lead 报的，已确认）`asset_protocol_url` 在 Windows 上返回
  `http://poietica-asset.localhost/asset/<s>/<t>`，那是 Tauri/WebView2 时代的绕法。ADR 0028 换成
  Electron 之后 `apps/desktop/electron/main.ts:39` 已把 `poietica-asset` 注册成特权 scheme，
  没有任何东西应答那个 http 源 —— 图片附件预览 100% 挂。**改为三个平台同一条形状**
  `poietica-asset://asset/<s>/<t>`，删掉 `cfg!(windows)` 分支与随之作废的
  `ASSET_PROTOCOL_LOCALHOST`（含 `lib.rs` 的 re-export）。新增两条单测：
  形状逐字相等、且不含 `localhost`；乱码 token 仍拼不出 URL。
  证据：`cargo test -p poietica-asset` 19 passed。（TS 侧解析由 audit-desktop 同步改。）

- **crates/agent-client/src/session/bridge.rs:1776**（正确性，最重的一条）人答过的授权
  **从来没有写回账**。`record_permission_resolved` 在生产代码里只有 `record_pending_cancelled`
  这一个调用方，而收摊那条路只处理**还挂着**的请求（`approvals.retain` 会先摘掉已答的），
  于是每一帧 `permission_requested` 在账上都没有终局。ADR 0002 说这份日志才是权威、
  `permission-dock.tsx:16` 也指着它，照原文读它是错的。
  修复：`DialogRequested` 那一支把 slot 留住并交给答复任务，答复回桥之后（不论成败）
  记一帧 `permission_resolved`，与提问那条路（`QuestionsResolved`）同形。
  证据：新增 `an_answered_approval_is_filed_as_resolved_with_the_decision_the_human_gave`；
  **把它单独回退成 `let _ = &slot;` 后该测试确实失败**（`must be filed as resolved: Elapsed(())`），
  恢复后 69 passed。

- **crates/agent-client/src/recorder.rs:160**（正确性）跨轮的丢帧账算到了下一轮头上。
  `lost` 只在 `settle_pending_end` 里清零，而那要等一轮落过终帧；两轮之间掉的那几帧
  （链路态之类）会一直挂到下一轮的终帧，把一轮跑得好好的对话报成
  `RunFailed: dropped N frames of this turn`。修复：准入成功即开新的一轮，旧账到此为止。
  证据：新增 `frames_dropped_between_turns_are_not_charged_to_the_next_one`，
  **修复前确实失败**（`Ok([..., RunFailed { message: "the journal dropped 1 frames" }])`），
  修复后通过。

- **crates/ledger/src/index/threads.rs:401 → 528**（性能）收割幽灵行**一行一次事务提交**，
  `delete_thread` 自开事务、循环里逐个调用。WAL + `synchronous=FULL`（`connection.rs:51`）
  下每次提交就是一次 fsync。200 行实测 **323.06 ms → 7.85 ms**（41×，同一台机器、
  同一 `measure_ghost_harvest`）。修复：整批一个事务；删除的四条语句收成唯一一份
  `delete_thread_in`，让 `delete_thread` 与收割两条路共用（抄第二份就会在某一处漏一张表）。
  证据：`a_batch_of_ghosts_is_harvested_whole_with_its_disposals`（25 行全部落账、处置账齐全）；
  `measure_ghost_harvest`（`--ignored`）留下来供复算，数字写在注释里。

- **crates/agent-client/src/session/bridge.rs:609**（性能）每一条应答都整份克隆一次载荷。
  `Frame::Response` 为了读一个 `sessionId` 先 `data.clone()`，而它紧接着就要把整份
  `data` 交给调用方 —— transcript 基线一页可达数 MB，等于**每次打开一条对话都白复制一整页**，
  且在读循环这条最热的路上。修复：指派那一格在移动之前先摘出来，`reply.send(Ok(data))`。
  证据：`cargo test -p poietica-agent-client --lib` 69 passed（全部走读循环解帧的用例不变）。

## 仅报告

- **crates/ledger/src/migrations/sql/0005_thread_projection.sql / 0004_kap_cursors.sql**：
  `thread_projection`、`kap_cursors`、`session_cursors` 三张表**全仓零读者零写者**
  （grep 只有建表语句本身）。它们是 kap 时代的遗留（`session_cursors` 直接叫 kap）。
  建议按「迁移只追加」的纪律开一条新迁移把三张表 DROP 掉，而不是删旧 SQL 文件。
  收益：数据库少三张永久不写的表。
- **crates/agent-client/src/session/book.rs:165 `ids()`**：生产代码零调用方（只有定义）。
  删除即可。
- **crates/agent-client/src/session/book.rs:78 `current_prompt()`**：公开方法零调用方；
  它内部用的 `Recorder::current_prompt` 有测试，但那条公开出口没有。
- **crates/agent-client/src/session/mod.rs:248 `SessionEntry`**：定义 + `lib.rs` re-export，
  零使用。ADR 0018 缺口清单里的「会话列举」至今没接，这个类型是那次尝试的残骸。
- **crates/conversation/src/link.rs:11 `LinkState` 整条链是死的**：没有任何生产者 ——
  `Event`（wire.rs:293）里没有 link 事件，所以 `SessionEvent::Link` 与
  `conversation-runtime/src/events.rs:45` 的 `book.note_link(link)` 永不执行。
  要接链路态就必须先给桥加一帧；在那之前这三级（link.rs / SessionEvent::Link /
  note_link）都是空转，建议在文档或 ADR 里如实登记为「还没接」，不要让它看起来可用。
- **crates/agent-client/src/session/client.rs:464 `read_media`**：恒返回 `unwired`，
  而 `conversation-runtime/src/runtime/queries.rs:237` 与
  `packages/native-bridge` 的 session.ts:117 都已把它当「已知未接」登记；
  这条与本任务无关，只是把「它确实是恒失败」钉实。
- **crates/automation-runtime/src/scheduler.rs:74 `Runtime::stop`**：先 `stopping.cancel()`
  再取 `self.worker` 锁，而 `drive` 的 select 分支在取消后**仍会先跑完一次
  `schedule()`**（`tokio::select!` 的第二段）—— 取消到真正退出之间多一次完整的
  调度对账（一次 SQLite 读 + 一次写）。影响有限（退出慢一拍），但「先停收活」的语义
  与代码顺序不一致；建议在循环体开头补一次 `if stopping.is_cancelled() { break }`。
  未改：属于行为微调，需要确认是否与既有的 shutdown 测试冲突。
- **crates/agent-client/src/process/stderr_probe.rs:46 `tail()`**：诊断正文（40 行 × 2000 字符）
  只在轮终失败与握手超时两处读，写侧却在**每一行 stderr** 上取一次锁。代价很小
  （未测出可复现的开销），但结构上是「热写冷读却加锁」。仅报告，不为此改。
- **SQLite 索引**（已核对真实库的执行计划，无人为猜测）：`list_threads`、
  `events_after`、`MAX(seq)`、`turn_cut`、`session_is_bound`、`unresolved`、
  `workspace_roots` 全部命中索引或覆盖索引，**没有发现缺索引导致的全表扫描**；
  真实库（`%APPDATA%/@poietica/desktop/ledger.sqlite3`）逐表行数：`threads` 0、
  `conversation_events` 0、`session_disposals` 2、其余 0，所以没有 N+1 现场可测。
  唯一值得记一笔的是 `workspace_root_in_use` 走 `workspace_roots()` 的三路 UNION
  （含两次 `json_each` 全表展开），但它在删除与启动对账两条冷路上，且
  `threads.rs:353` 的注释已把「判据只留一份」列为刻意取舍 —— 不改。
- **`DeliveryOutcome::Sent` 不可达**：`crates/ledger/src/conversation/outbox.rs:45` 把
  `Sent` 也算作 `attempted`，但 `KapGateway::deliver`（gateway.rs）从不报 `Sent`，
  于是 `delivery_outbox.state` 永远到不了 `'sent'`，而
  `outbox.rs:72` 的 `IN ('pending','sent','unknown')` 与迁移里的 CHECK 仍然认它。
  仅报告：删 `Sent` 要改已落盘的取值域（那条 CHECK），不是本任务该顺手做的。
- **`apps/desktop/native` 的薄封装**：逐条核过 `ipc/mod.rs` 分发表的 76 条命令，
  没有发现「不经宿主端口就能写出的逻辑住在 native」的实例 —— 命令体都是解参 →
  转 DTO → 调 crate。唯一略厚的是 `agent::install::compute/install`（约 100 行），
  但它读 `documents()`（agents.json）与 `CHECK_TTL_MS` 缓存这两样只有宿主知道的东西，
  留在组合根是对的。

## 方法说明

- 真实数字只有两个来源：`cargo test`（含上面两条新用例）与 SQLite 真库的
  `EXPLAIN QUERY PLAN`；报告里没有一处「看起来更快」。
- 未改动的发现一律写明为什么没改（要么超出范围，要么需要先定决策）。
