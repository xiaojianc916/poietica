# 0040 — 日志改用事实标准：electron-log 与 tracing 栈

日期：2026-10-04

## 背景

日志以前是我们自建的一条链路，三处各写了一遍同一件事：

| 位置 | 自建内容 |
| --- | --- |
| `packages/native-bridge/src/diagnostics/log-sink.ts` | 截渲染层 console、5 秒去重、400 条会话上限 |
| `apps/desktop/electron/logging.ts` | 再截一遍主进程 console、同一套去重与上限、崩溃事件 |
| `apps/desktop/native/src/log_file.rs` | 595 行：手拼 JSON Lines、4MB 轮转、再去重一遍、再脱敏一遍、自己实现 `log` 门面 |

去重三份、脱敏两份、级别闸门三份。这违反 AGENTS.md 的「同款逻辑第二份出现即为缺陷」。

## 决定

**Electron 官方能力 + 事实标准依赖**，不再自建：

1. **日志目录归宿主，且钉在数据根里**。目录用 Electron 的官方机制
   `app.setAppLogsPath()` 定，然后由 `main.ts` 在 `NativeHost.start` 时交给原生侧
   （`HostPaths.logDirectory`），于是两个进程写同一个目录，「日志在哪」只有一个答案。
   **必须显式钉**：不钉的话 `app.getPath('logs')` 在 macOS 上是
   `~/Library/Logs/Poietica`，数据就跑到 ADR 0031 划定的数据根外面去了 ——
   Windows/Linux 恰好落在 userData 下面，于是同一份代码在三个平台有两种布局。
2. **JS 侧用 electron-log 5.4.4**。Electron 这一档的事实标准：渲染层经 IPC 交回主进程、
   轮转、级别、崩溃钩子全都有。选它而不是 pino：pino 完全不认识 Electron 的进程模型
   与日志目录，用它仍要自己补传输与轮转，等于留着旧链路的一半。
3. **Rust 侧用 tracing 0.1 + tracing-subscriber 0.3 + tracing-appender 0.2**。
   事件面与落盘都是 tokio.rs 团队那一份：JSON 形状、轮转（按日、留 7 份）、级别过滤
   各由官方实现给。`log` 门面与手写落盘一并删除。
4. **删掉那套 5 秒去重**。事实标准里去重是采集器的职责，客户端 logger 只做轮转与
   体积上限。刷屏是调用点循环的 bug，不是日志库的责任。
5. **线上形状是 JSON Lines，字段对齐 OTel Logs 数据模型**
   （`timestamp` / `level` / `target` / `message`）。**不引 OpenTelemetry SDK**：
   那是给有 collector 的服务端的标准，本地优先、无后端的桌面应用引它只有 exporter
   与资源探测的负担。抄字段名，不抄框架 —— 将来真要接遥测，filelog receiver 吃的
   是同一份文件。
6. **脱敏是本地不变量，两边各有一份实现**。密钥与用户目录不落盘，不交给上游自觉：
   原生侧在自定义 `FormatEvent` 里过一遍，主进程在 `log-line.ts` 里过一遍。
   判据同源，但实现必须各有一份 —— 一个跑在 Rust、一个跑在 JS。
7. **两份文件，不是一个**。原生侧 `poietica.log`、主进程 `main.log`。两个库各有各的
   轮转实现，写同一个文件会互相吃掉对方的行。
8. **一行的形状自己写，写出多少交给库**。边界是硬的：electron-log 管「什么时候写、
   写多少、写到哪」，我们只管「写出来的一行长什么样」。它默认写
   `[时间] [级别] 正文` 的纯文本，我们不接受两份文件两种格式，所以 `file.format`
   换成 `log-line.ts` 那一行 JSON。同一侧的 `tracing` `FormatEvent` 也是这个道理：
   那个位置本可以塞官方的 `format::Json`，但脱敏必须发生在**写之前**，官方那层没有
   插手正文的钩子。

## 影响

- 删除：`apps/desktop/native/src/diagnostics.rs`、IPC 命令 `diagnostics_log_append` /
  `diagnostics_log_read`（类型表、函数表、分发臂三处）、`log-sink.ts`、`read-log.ts`、
  `HostBridge.diagnostics` 端口、`ipcMain.handle('poietica:diagnostics-log')`。
- 87 处 `log::` 宏迁到 `tracing::`；5 个 crate 的 `log` 依赖换成 `tracing`。
- `HostPaths` 多一格 `logDirectory`；`paths.rs` 不再自己拼 `logs` 这个名字。
- 渲染层的诊断缓冲（`packages/problem` 的 200 条内存环）**保留**：它服务的是崩溃屏
  「复制诊断信息」那一次快照，与事后回看不是同一件事。
