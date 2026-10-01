# 0024 — Transcript IPC 去双重序列化、桥侧攒批与技能载荷裁剪

状态：accepted
日期：2026-09-29
触及：IPC 契约、agent-bridge 协议时序、conversation-runtime DTO

## 背景

性能审计（bench:open ×128 档，80 MB 载荷）揭示三条结构性浪费：

1. **Transcript 双重序列化**：`AgentTranscriptJson { json: String }` 让 Rust 先
   `Value::to_string()`，Tauri 再把内层 JSON 转义成字符串字面量，TS 再 `JSON.parse`
   回来。80 MB 载荷走 5 趟序列化/反序列化，其中 3 趟是纯浪费。
2. **桥侧逐 delta 发射**：每个 text/thinking delta 都立即 `mirror.accept()` + `emit`，
   一轮流式回复产出数千次 webview IPC 往返，每次付 Rust 序列化 + 转义 + TS 解码。
3. **Builtin 技能正文过桥即丢**：`agent_toolkit` 把全部技能的 `document`（整份
   SKILL.md）序列化过 IPC，TS 侧 `capability-store.ts:62` 立即 filter 掉 builtin。

## 决策

### A. AgentTranscriptJson 改内联 Value

- `crates/conversation-runtime/src/runtime/queries.rs`：`transcript()` 与
  `transcript_ops()` 返回 `serde_json::Value`（去掉 `.to_string()`）。
- `crates/conversation-runtime/src/runtime/threads.rs`：`OpenedThread.transcript`
  类型从 `String` 改 `serde_json::Value`。
- `apps/desktop/native/src/conversation/dto.rs`：`AgentTranscriptJson.json` 与
  `AgentTranscriptEvent.json` 类型从 `String` 改 `Value`。
- `apps/desktop/native/src/conversation/composition.rs`：事件路径去掉
  `payload.to_string()`，直接 move Value。
- TS 侧 `transcript-decoding.ts`：`decodeTranscriptEvent` 不再 `JSON.parse(wire.json)`；
  `transcriptPageOf` 签名从 `(json: string)` 改 `(raw: unknown)`。
- 生成契约 `ipc-bindings.ts`：`json: string` → `json: any`（specta 对 Value 的映射）。

**收益**：去掉 Rust 侧一次全量 `to_string()`、Tauri 一次转义序列化、TS 一次
`JSON.parse`。80 MB 载荷预计省 ~40 ms Rust 侧 + ~15 ms TS 侧。

### B. 桥侧 transcript ops 攒批（16ms 窗口）

- `packages/agent-bridge/src/bridge.ts`：`pushTranscript` 增加第三参 `immediate`。
  默认走 16ms 攒批窗口（per-session buffer + timer），窗口关闭时一次
  `mirror.accept(allOps)` 产出一个信封（一个 seq，多个 ops）。
- 关键事件（turnEnd、userTurn、interaction ops）标记 `immediate = true`，
  保证屏幕状态不被延迟。
- 轮终 emit 前显式 `flushTranscript(record)`，保序。

**收益**：流式期间 emit 数降 N 倍（N = 16ms 内 delta 数，典型 5-20）。
每次省掉 Rust 序列化 + webview IPC post + TS 解码。seq 语义不变（恰好 +1）。

### C. Builtin 技能 document 不过 IPC

- `crates/conversation-runtime/src/toolkit.rs`：`restate_skill` 对
  `source == "builtin"` 的技能设 `document: None`。

**收益**：`agent_toolkit` payload 从"N 份 SKILL.md 正文"降到"N 行名字+描述"。
典型 builtin 技能 10-30 个，每个 document 2-20 KB，省 20-600 KB/次。

### G. browser_set_bounds / terminal_write 改 emit（待实施）

审计确认 `browser_set_bounds` 逐 rAF 帧发 command（返回 `()`），
`terminal_write` 逐击键发 command（TS 侧 `.then(() => undefined)` 丢弃结果）。
两者均可改 Tauri event（JS→Rust `app.listen`），省掉 reply 路径。

**阻塞**：桌面包 build script 因 `binaries\bun.exe` 文件锁无法编译验证。
待锁解除后实施，需同步从 `ipc/mod.rs` 的 `surface()` 移除对应命令并
`bun run ipc:generate`。

## 不变量守卫

- zod 仍是 transcript 数据的唯一校验点（`transcriptResponseSchema`、
  `transcriptOpsPayloadSchema`）。Value 透传不绕过校验。
- seq 恰好 +1 的语义不变：攒批合并的是 ops 数组，不是信封。
- `mirror.page()` / `mirror.catchUp()` 在攒批窗口内最多落后 16ms，
  对 open_thread（用户操作）和 reconnection（秒级）无感知影响。
- Builtin 技能的 `document: None` 不影响 `skill-document-pane`：
  该面板对 builtin 显示"无正文"（`skill.body === undefined` 分支已存在）。

## 后续

- 桌面包编译验证后，从 `surface()` 移除 `browser_set_bounds` / `terminal_write`，
  改注册 `app.listen` 事件处理器。
- `bun run ipc:generate` 重生成契约（当前手改了 `ipc-bindings.ts` 的 `json: any`，
  正式生成后应一致）。
- 考虑 zod AOT 编译（`z.compileFn` 构建期出码 + `withParser`）进一步压缩 decode
  阶段的 139 ms（占 total 84%），但需解决 CSP `unsafe-eval` 限制。
