# @poietica/process-kit

Windows 进程工具（L2）：运行子进程、查找可执行文件、枚举进程与结束进程树。

## 关键导出

- `run`：参数数组启动并收集 UTF-8 输出；失败分为 `spawn`、`exit`、`timeout`、`aborted`
- `which`：按 `PATH` 与 `PATHEXT` 查找，环境可注入
- `listProcesses`：经 `tasklist` 与 PowerShell `Win32_Process` 枚举
- `killTree`：`taskkill /T /F` 结束整棵树，永不 reject

## 约束

仅 Windows；`run` 不经过 shell，超时或中止时结束整棵进程树。

层级见 [架构文档 §3](../../docs/ARCHITECTURE.md#3-分层与依赖规则)。
