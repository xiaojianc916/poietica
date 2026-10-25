# @poietica/runtime-layout

运行时布局（L2）：将数据根解析为唯一的 `DataLayout`，并给出 Core 的参数、启动环境与退出码约定。

## 关键导出

- `dataLayout`、`resolveDataRoot`：纯路径计算
- `parseCoreArgs`：解析 `serve` 的白名单参数
- `buildCoreLaunch`、`ompIsolationEnv`：清洗环境并注入 omp 隔离变量
- `CORE_EXIT_CODES`、`CORE_SHUTDOWN_BUDGET_MS`、`BROWSER_PARTITION` 与缓存预算

## 约束

数据路径只来自 `DataLayout`。omp 隔离见 [架构文档 §6](../../docs/ARCHITECTURE.md#6-引擎端口与-omp-隔离)，数据归属见 §7。
