# 0049. Opening a conversation reads the transcript once

- Status: Accepted
- Date: 2026-09-21
- Owners: Conversation transcript domain

## Context

打开一条对话时，server 的整份正文被要了两次（冷会话），其中一次是纯粹白花。

正文是这一路上唯一随对话大小线性放大的东西：本机最大的真实对话 631 KB，冷会话的
正文由 server 从 wire records 现场重建，一次往返实测 6–10 ms。多要一次，用户就多等
一次，且多解一次（Rust 侧 `from_str` + `to_string` 约 2.9 ms，TS 侧 `JSON.parse` +
zod 约 1.0–1.5 ms）。

两处各自的判据都过宽：

1. **`TranscriptReplica.#catchUp`** 要求 `folded.complete` 为真才认账。
   `complete:false` 只说 journal 够不着 `since_seq`，不说两家水位不同。冷会话恒回这一档
   （`latestSeq: 0`、`batches: []`），而我们手上那一页的水位本就是 0 —— 中间没有任何
   待补的帧，却照旧整读了一次 head。
2. **`TranscriptReplica.#restart`** 对每个 `transcript.reset` 都重读一页。
   server 的 reset 载荷恒为空尾巴（`items: []`、`has_more_older: true`），它整发的是
   「从当前水位起的尾巴」；水位与我们手上那一页相等时，那截尾巴我们已经有了。

`reset` 里本来就带着 `seq`（server 自报的当前水位），但 `decodeTranscriptEvent` 把它
丢了，下游无从判断。

## Decision

1. `TranscriptSignal` 的 `reset` 变体带上 `seq: number | undefined`：server 自报的水位。
   `transcript-decoding.ts` 原样透传，不猜。
2. `#catchUp` 的恢复判据由「批次日志连不连续」改为「我们到没到 server 的水位」：
   `folded.cursor !== caught.latestSeq` 才去读 head。`complete:false` 而水位相等时，
   两处之间没有待补的帧。
3. `#restart` 收下水位：与手上那一页相等就不再读，只换掉 feed 身份（在飞的老读法必须
   作废，这一条不省）。水位未知、或比手上那份新时，照旧走 REST —— 中间那些帧只有它能补。
4. 水位相等时不重读，但 `reset` 仍是失效屏障：feed 身份照换，在飞的读法与游标照旧作废。

## Consequences

- 打开一条对话，server 的正文从 2 次降到 1 次（本机 180 条对话里 178 条是冷会话）。
  按本机实测每趟省 ≈ 4 ms（Rust 2.9 + TS 1.0–1.5），外加一次 6–10 ms 的往返等待。
- 四段同步工作（解码 / 装入 / 投影 / 成帧）本身没有变快，也没有变慢：这次只删等待与
  重复解码，不动投影。631 KB 那条实测总计约 1.9 ms，本来就不是瓶颈。
- `TranscriptSignal` 是 `@poietica/conversation` 的公开面，形状变了；仓内只有
  `native-bridge` 与 `conversation` 自己构造它。
- ADR 0041 的恢复归属不变：reducer、feed 身份、REST 补给窗口、分页必须前进这四条
  都原样保留，本次只收窄了「什么时候必须去读」的判据。

## Evidence

- 线上时序（本机 kimi web 0.29.x，`GET /api/v1/sessions/{id}/transcript` 与
  `subscribe_v2`）：
  - 冷会话（178/180）：订阅只回 ack；正文页**没有 `seq`**；`/transcript/ops` 回
    `complete:false, latest_seq:0, batches:[]`。
  - 在跑的会话（2/180）：订阅回每条 agent 一个 `transcript.reset`
    （`items:[]`、`has_more_older:true`、`seq:1`）；正文页带 `seq`；ops 回 `complete:true`。
  - `reset` 在 Rust 的 `activate` 里订阅（`subscribe_transcript`），早于 `open_thread`
    读正文，所以它在 `route` 之前抵达 TS。
- 闸门：`bun run bench:reads`。修前冷会话与在跑的会话各 2 次（重取 1 次，1263 KB），
  修后各 1 次（重取 0 次，631 KB）。这是计数，不受机器噪声影响。
- 四段计时：`bun run bench:open`（631 KB / 5 MB / 20 MB / 80 MB 四档）。
- 回归测试：`packages/conversation/src/transcript/__tests__/transcript-store.test.ts` 的
  「a reset at our own watermark does not refetch the page we already hold」，
  以及两条反向用例（水位更前、水位未知都必须照旧去读）。
- fixture 与量法见 `tests/benchmark/README.md`。
