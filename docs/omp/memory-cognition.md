# omp 记忆与认知子系统

> 来源：`CA/src/memories/`、`CA/src/memory-backend/`、`CA/src/advisor/`、`CA/src/goals/`、`CA/src/autolearn/`、`CA/src/auto-thinking/`、pi-mnemopi 包、包 README（18.3.0）。

## 1. 记忆 backend（五选一，`memory.backend`）

| backend | 机制 |
|---|---|
| `off`（默认） | 不运行记忆子系统 |
| `local` | rollout 摘要管线：启动时扫描既有会话（memories.* 配置：maxRolloutsPerStartup 64、maxRolloutAgeDays 30、minRolloutIdleHours 12、threadScanLimit 300、maxRawMemoriesForGlobal 200、stage1Concurrency 8 + lease/retry、phase2 lease/retry/heartbeat、rolloutPayloadPercent 0.7、phase1InputTokenLimit 4000、fallbackTokenLimit 16000、summaryInjectionTokenLimit 5000），两阶段巩固，写 `memory_summary.md` 与巩固产物到 agent dir |
| `hindsight` | 对接 Hindsight 服务器（Cloud 或自托管 `docker run -p 8888:8888 ghcr.io/vectorize-io/hindsight:latest`）：每 N 轮（retainEveryNTurns 3，retainOverlapTurns 2）retain transcript；会话首轮 recall（recallMaxTokens 1024、recallTypes ["world","experience"]、recallBudget、recallContextTurns 1、recallMaxQueryChars 800）；工具 retain/recall/reflect；mental models（mentalModelsEnabled/AutoSeed/MaxRenderChars 16000）；超时组 request 30s/reflect 120s/recall 30s/retain 60s；全套 env 覆盖（HINDSIGHT_*，env 优先） |
| `mnemopi` | 本地记忆引擎包（`@oh-my-pi/pi-mnemopi`）：SQLite（mnemopi.dbPath）+ embedding 检索（embeddingVariant、fastembed 缓存、`MNEMOPI_EMBEDDING_MODEL`、专用 embed worker `__omp_worker_mnemopi_embed`；noEmbeddings 退化词法）、autoRecall/autoRetain、polyphonicRecall/enhancedRecall/proactiveLinking、retainEveryNTurns 4、recallLimit 8、recallContextTurns 3、recallMaxQueryChars 4000、injectionTokenLimit 5000、LLM 辅助巩固（llmMode/BaseUrl/ApiKey/Model）；**唯一支持 memory_edit 的 backend** |
| `sharpshooter` | 间隔式后端：extract/consolidate/queue/scheduler——从会话流提取并巩固记忆；`sharpshooter.model` 指定提取模型、intervalMinutes 5、injectionTokenLimit 15000 |

- **切换语义**：`memory.backend` 切换即时替换 live backend、memory 工具、listeners、system-prompt 上下文（README 明示；`AgentSession.applyMemoryBackend()` 可编程触发）。
- **迁移**：旧 `memories.enabled = true|false` 用户一次性迁移为 `memory.backend = "local"|"off"`；此后 `memory.backend` 是唯一运行时选择器。
- **subagent**：经 `parentHindsightSessionState/parentMnemopiSessionState` 别名父状态；`memoryTaskDepth` 抑制嵌套替换。

## 2. 记忆工具语义（注册面见 tools.md）

| 工具 | 参数 | 语义 | 门控 |
|---|---|---|---|
| `retain` | `items: [{content, context?}]`（≥1） | 写入长期记忆（mnemopi rememberScoped importance 0.75 / hindsight 批量 retain） | backend ∈ {hindsight, mnemopi} |
| `recall` | `query` | 搜索长期记忆；mnemopi 返回带 id 列表（供 memory_edit 引用）；无结果标 `useless` | 同上 |
| `reflect` | `query, context?` | 从记忆合成答案（hindsight client.reflect / mnemopi 召回汇总） | 同上 |
| `memory_edit` | `op: update|forget|invalidate`、`id`、`content?`、`importance?`（0–1）、`replacement_id?` | 编辑/遗忘/失效记忆 | 仅 mnemopi |
| `learn` | `memory`（必需，自包含经验教训）、`context?`、`skill?: {action: create|update, name, description, body}` | 沉淀经验；带 skill 时同调用铸造 managed skill | `autolearn.enabled`（false）+ backend ∈ {hindsight, mnemopi, local} + 顶层 |
| `manage_skill` | `action: create|update|delete`、`name`（kebab-case）、`description?`、`body?` | managed skill 管理（不能覆盖同名 authored skill——被遮蔽返回 isError） | `autolearn.enabled` |

approval：learn 带 `skill` 或 backend=local 时 write，否则 read；manage_skill write。

## 3. mnemopi（本地记忆引擎包）

- SQLite 存储（dbPath）；embedding：fastembed（缓存 `~/.omp/cache/fastembed/`、运行时 `cache/fastembed-runtime/`）、`cosineSimilarityPairs/vectorIndexTopK` 原语走 pi-natives；专用 embed worker 子进程隔离。
- 检索：polyphonicRecall（多声部召回）、enhancedRecall、proactiveLinking（主动关联）；无 embedding 模式退化为词法。
- 巩固：LLM 辅助（llmMode/BaseUrl/ApiKey/Model）。

## 4. Advisor（第二模型审查，`CA/src/advisor/`）

- 每轮由独立 advisor 模型（role `advisor`）**旁路审查主对话**；产出建议经 **advise 工具**（`advise-tool.ts`，`intent="omit"` 不写 transcript intent）投递主模型。
- 组件：
  - `emission-guard`：去重/预算/抑制（`advisor.maxNotesPerUpdate` 4 条/更新）；`message-fingerprint.ts` 指纹去重；
  - `loop-guard.ts`：防 advisor 自己成环；
  - `watchdog.ts`：advisor 卡死检测（预置 watchdog prompt；`advisorWatchdogPrompt/advisorSharedInstructions` 来自 WATCHDOG.yml 发现）；
  - `transcript-recorder.ts`：advisor 侧 transcript；
  - `delta-split.ts`：增量拆分；
  - `config.ts`：`advisor.enabled/syncBacklog(off|1|3|5)/immuneTurns(3)`；`tier.advisor` 独立 service tier。
- 事件：`advisor_cost_changed`、`advisor_yielded`；无头收尾：`prepareForHeadlessAdvisorDrain()` + `waitForAdvisorCatchup(timeoutMs)`；print 模式 drain 10min（错误出口 30s）；abort 时被搁置的 advisor 卡片重录为可见建议。
- advisor 会话工具面：`advisorTools`（advisor-scoped tool session）、Cursor 帧桥（advisorCreateGrepTool/advisorCreateEditTool）、approval 上下文（无 context 时 **fail-closed always-ask 空策略**）、MCP 资源适配（advisorMcpResources）。

## 5. Goals（目标模式，`CA/src/goals/`）

- `goal` 工具（hidden）：`op create|get|complete|resume|drop` + `objective` + `token_budget`（正整数）；`/guided-goal` 引导访谈创建（无 goal 记录时暴露）。
- 运行时（`goals/runtime.ts`）：`GoalRuntimeHost` 接口（getState/setState、getCurrentUsage、emit、persist(mode: "goal"|"goal_paused"|"none")、sendHiddenMessage {customType, content, deliverAs?: steer|followUp|nextTurn}）；`GoalTurnSnapshot {turnId, baselineUsage, activeGoalId?}`；状态机 active/paused/dropped。
- 配置：`goal.enabled`（默认 true）、`goal.statusInFooter`、`goal.continuationModes`；事件 `goal_updated {goal, state?}`；`sendGoalModeContext(deliverAs?)` 注入模式上下文。

## 6. autolearn（`CA/src/autolearn/`）

- `autolearn.enabled`（默认 **false**）：会话经验自动沉淀——`controller.ts` + `managed-skills.ts`（autolearn 铸造的技能落 `~/.omp/agent/managed-skills/`，独立最低优先 provider；`isValidManagedSkillName`、`sanitizeManagedDescription`）。
- SDK 导出 `createAutoLearnCaptureRunner`；AgentSession `runAutolearnCapture(capture)`；abort 时一并取消。

## 7. auto-thinking（`CA/src/auto-thinking/`）

- classifier：按输入复杂度自动调节 thinking level（minimal…max 自适应）；`providers.autoThinkingMaxEffort` 上限；事件 `thinking_level_changed {thinkingLevel, configured?, resolved?}`（resolved = auto 本轮解析值）；`isAutoThinking`/`autoResolvedThinkingLevel()`。
