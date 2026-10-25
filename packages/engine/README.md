# @poietica/engine

引擎端口层：业务只依赖这里的接口与纯函数，不接触 agent 运行时。

## 职责

定义 `AgentEngine`、`EngineSession` 与六个能力端口（会话文件、模型、设置、技能、MCP、插件），并收拢事件、词表、工具规格、错误码与 relay 形状。实现只有 `@poietica/engine-omp`，`@poietica/engine-testkit` 提供替身与一致性套件。

## 关键导出

- `AgentEngine`：`draftControls`、`commandCatalog`、`openSession` 与工具注册；工具表须在首次 `openSession` 前冻结。
- `EngineSession`：提交、取消、队列、交互、`page`、`runCommand`、子代理与侧边提问。
- `SessionFilesPort`：管理会话文件，以 `readPage` / `sideTopics` 冷读未打开的会话。
- `interactionCardOf` 把交互映射为 transcript 卡片；`values.ts` 定义 zod 词表。

## 边界

本包只有接口与纯函数，不依赖 omp；功能层不得依赖 engine-omp。relay 形状的对齐由 engine-omp 的类型检查钉住。

详见 [§3 分层](../../docs/ARCHITECTURE.md#3-分层与依赖规则)、[§6 引擎端口与 omp 隔离](../../docs/ARCHITECTURE.md#6-引擎端口与-omp-隔离)。
