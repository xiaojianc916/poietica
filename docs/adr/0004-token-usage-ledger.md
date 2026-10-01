# Token 用量记账

## 背景

agent 报的用量读数是仪表值：这条会话此刻占了多少上下文。它到达即替换，不是
增量，所以此前把它整块 JSON 存进 `threads.usage` 只回答得了「现在占多少」，
回答不了「今天用了多少」——设置页的用量因此一直是空账。

## 决定

- 账落在 `crates/ledger`：`session_usage` 存每条会话的读数，`token_days` 存
  每一天的累计，增量在同一次事务里算出。读数只有这一份，它同时是打开对话时
  要显示的那一份，不再有第二处副本。
- 回落按整笔计入：读数变小只可能来自上下文压缩，而压缩后整份上下文会被重新
  送进模型，与 Prometheus 对计数器重置的读法一致。
- 载荷只在 IPC DTO 层解释一次，跨进程的形状由生成绑定给出，渲染侧不再手写
  校验。
- 日历日取 `date('now','localtime')`，与渲染侧 `dayKeyOf` 的本地日历键同源。

## 影响

- 迁移 0006 建 `session_usage` 与 `token_days` 两张表；后续迁移补上
  `input_other` / `input_cache_read` / `input_cache_creation` 三列，撤掉
  `threads.usage`。
- IPC 面新增只读命令 `usage_token_days`（`crates/ledger/src/index/usage.rs`
  是唯一写点，`apps/desktop/native/src/ipc/mod.rs` 转发）。
- `sessionUsageOf` 与 `SessionUsageCost` 已移除：前者是手写的线上校验，后者
  全链路没有产出方。
