# @poietica/engine-omp

`@poietica/engine` 端口的生产实现：全仓唯一 import `@oh-my-pi/*` 的地方（`apps/core/scripts` 构建脚本除外）。

## 职责

在隔离数据根内初始化 omp 的 Settings、模型注册表、MCP 工作区与端口，把会话、工具、交互和浏览器 relay 适配为 engine 契约。创建顺序与产品默认值集中在 `create-engine.ts`；relay 端口每代 Core 现挑，口令按数据根持久化。

## 关键导出

- `.`：`createOmpEngine`，接收 `DataLayout`、logger、`appVersion` 与可选的 `engineVersion`。
- `./bootstrap`：`prepareIsolation`、`runIsolationSelfCheck`、`captureLaunchEnv`、`dispatchProcessMode`、`installStdoutGuard`。
- `./testing`：`createOmpEngineForTest`，用 omp 自带的 mock provider 起离线引擎。

## 边界

只有 `apps/core` 可依赖本包。omp 数据只落在 `DataLayout.ompRoot`；全局 `~/.omp`、`.env` 与其它凭据变量由启动层屏蔽，自检不过拒绝启动。omp 版本只来自根 catalog。

详见 [§3 分层](../../docs/ARCHITECTURE.md#3-分层与依赖规则)、[§6 引擎端口与 omp 隔离](../../docs/ARCHITECTURE.md#6-引擎端口与-omp-隔离)。
