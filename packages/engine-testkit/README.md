# @poietica/engine-testkit

`FakeEngine` 与一致性套件：前者供功能测试离线使用，后者让同一套端口语义同时跑在替身与真实引擎上。

## 职责

提供不依赖 omp 的 `AgentEngine` 实现，覆盖会话、队列、交互、时间线、侧边提问与六个端口，由场景脚本驱动回复。一致性套件是可执行的端口定义：`make()` 返回的引擎须尚未冻结工具表，套件注册测试工具后自行冻结。

## 关键导出

- `createFakeEngine`、`FakeEngine`、`FakeEngineOptions`：内存引擎；`opened`、`toolCalls`、`prompts` 供断言。
- `runEngineConformance`、`ConformanceTarget`：同一套用例跑替身与 OmpEngine。
- `ScenarioScript` / `ScenarioStep` / `ScenarioTurn`、`defaultScript`、`say`、`callTool`：设定每轮的文本、工具、交互或失败。
- `SIDE_TURN_INDEX`：侧边提问在脚本中的固定轮号。

## 边界

本包只服务于测试与探针；替身不复刻 omp 的落盘与并发细节，新增行为应先在一致性套件中定义。

详见 [§3 分层](../../docs/ARCHITECTURE.md#3-分层与依赖规则)、[§8 测试策略](../../docs/ARCHITECTURE.md#8-测试策略)。
