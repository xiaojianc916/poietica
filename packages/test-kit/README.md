# @poietica/test-kit

测试辅助（L2）：可控时钟、临时目录、日志收集与真实 I/O 轮询。

## 关键导出

- `fakeClock`：支持 `advance`、`advanceAsync`、`runAllTimeouts`、`pendingTimers`
- `tempDir`：临时目录，`dispose` 在 Windows 上重试删除
- `createTestLogger`：按级别收集 `records`；`POIETICA_TEST_LOG=1` 时同时打印
- `waitFor`：按真实时间轮询至通过或超时

## 约束

`waitFor` 只用于真实 I/O；使用 `fakeClock` 时以 `advanceAsync` 推进。

测试分层见 [架构文档 §8](../../docs/ARCHITECTURE.md#8-测试策略)。
