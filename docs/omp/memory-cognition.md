# omp 记忆与认知子系统

> 来源：`CA/src/memories/`（index.ts 1456 行 + storage.ts 598 行 + settings.ts）、`CA/src/memory-backend/`（types/local-backend/runtime/redact/messages/tool-names）、`CA/src/prompts/memories/`（9 个模板）与 `prompts/system/`（memory/hindsight/mnemopi/autolearn 指令）、pi-mnemopi 包（`core/` 40+ 模块）、`CA/src/internal-urls/memory-protocol.ts`、`CA/src/sharpshooter/`（18.3.0 主体 + 18.4.4 复核）。

## 1. 记忆 backend（五选一，`memory.backend`）

`memory.backend` 是记忆子系统的**唯一运行时选择器**（enum：off/local/hindsight/mnemopi/sharpshooter，默认 **off**）。切换即时替换 live backend、memory 工具、listeners、system-prompt 上下文；旧 `memories.enabled = true|false` 一次性迁移为 `local|off`（`memories.enabled` 现仅作迁移兼容，UI 隐藏）。

### 1.1 backend 抽象接口（`memory-backend/types.ts`）

```
MemoryBackend {
  id
  start(options)              // 每会话一次；MUST 非抛出（坏 backend 不能拖垮 agent loop）
  buildDeveloperInstructions  // system-prompt 追加段（每次 refreshBaseSystemPrompt 重取）
  clear / enqueue / save / status / recall...
}
MemoryRuntimeContext { status(), search(query, {limit, signal}), save(input) }
MemoryBackendStatus { backend, active, writable, searchable, scope?, retainBank?, recallBanks?, workingCount?, episodicCount?, tripleCount?, lastMemory?, database?, error? }
```
实现必须自包含：自己管理 `start()` 创建的会话状态并在 `clear()` 拆除。

### 1.2 五种 backend

| backend | 机制 | 可写 | 可搜索 |
|---|---|---|---|
| `off`（默认） | no-op（不是用户选的"后端之一"，是缺省回落态；`/memory stats` 有专属文案） | 否 | 否 |
| `local` | rollout 摘要管线（§2）；`learn` 工具教训写 `learned.md` | 是 | 否（无结构化搜索） |
| `hindsight` | 外部 Hindsight 服务器（Cloud 或 `docker run -p 8888:8888 ghcr.io/vectorize-io/hindsight:latest`） | 是 | 是 |
| `mnemopi` | 本地 SQLite 记忆引擎（§4） | 是 | 是 |
| `sharpshooter` | 间隔式决策提取引擎（§5） | 是 | 是 |

## 2. local backend：rollout 摘要管线（`memories/`，包内提示词 `prompts/memories/`）

**原理**：把历史会话（rollout JSONL）两阶段蒸馏成每项目一份 `memory_summary.md` + `learned.md`，注入 system-prompt 开发者指令。

- **存储**（`memories/storage.ts`）：SQLite（`openMemoryDb`）表——`MemoryThread {id, updatedAt, rolloutPath, cwd, sourceKind}`、`Stage1OutputRow {threadId, sourceUpdatedAt, rawMemory, rolloutSummary, rolloutSlug, generatedAt, cwd}`、global watermark/lease。
- **Phase 1（stage1，逐会话蒸馏）**：启动任务 `startMemoryStartupTask` 扫描 rollouts（`memories.maxRolloutsPerStartup` 64、`maxRolloutAgeDays` 30、`minRolloutIdleHours` 12、`threadScanLimit` 300），按 lease 认领 job（`stage1LeaseSeconds` 120、`stage1RetryDelaySeconds` 120、`stage1Concurrency` 8 并发）；每个 thread 用 `stage_one_system.md` + `stage_one_input.md` 模板走 LLM（输入预算 `phase1InputTokenLimit` 4000），输出 raw memory JSON（失败标 failed 或 no-output，延迟重试）。
- **Phase 2（global 巩固）**：global watermark 驱动，`tryClaimGlobalPhase2Job`（lease 180s / retry 180s / heartbeat 30s）认领；取 `maxRawMemoriesForGlobal`（200）条 raw memories，用 `consolidation_system.md` + `consolidation.md` 跑巩固模型（输入预算 `fallbackTokenLimit` 16000），产出合并摘要；`applyConsolidation` 写 `memory_summary.md`。巩固系统提示全文要点：**1–3 句话总结；逐字保留每个事实/名字/数字/版本/日期/决策；合并重复点绝不复读；冲突只保留最新为当前；绝不发明/推断/添加；只输出总结句**。
- **注入**（`buildMemoryToolDeveloperInstructions`）：每项目 memory root（`getMemoryRoot = memoriesDir/<encodeProjectPath(cwd)>`——**按项目隔离**）读 `memory_summary.md` + `learned.md`，经 `read-path.md` 模板渲染成开发者指令；总结与 lessons **共享一个注入预算** `summaryInjectionTokenLimit`（5000 token，≈4 chars/token；总结占满后 lessons 直接丢弃，预算 clamp 0 防负数）；启动维护完成后 `refreshMemoryToolDeveloperInstructionsCacheAfterStartup` 刷新活动会话快照；`/memory clear` 即时清缓存。
- **learn → learned.md**：`learn` 工具经 `saveLearnedLesson` 追加到项目 memory root 的 `learned.md`（文件名刻意区别于用户自己的 MEMORY.md，防覆盖）。
- **脱敏**（`memory-backend/redact.ts`，全 backend 共享）：写记忆前抹除凭据形 token——AKIA/ASIA、ghp_/gho_/ghu_/ghs_/ghr_、github_pat_、npm_、xox[baprs]-、AIza 等固定前缀（单遍无回溯正则）。注释明示动机：**recall 会把存下的记忆放回 prompt，一条存下的凭据会在之后每一轮发给每个 provider**。

## 3. 记忆工具（注册面门控见 tools.md）

| 工具 | 参数 | 语义 | 门控 |
|---|---|---|---|
| `retain` | `items: [{content, context?}]`（≥1） | 写长期记忆（mnemopi rememberScoped importance 0.75 / hindsight 批量入队） | backend ∈ {hindsight, mnemopi} |
| `recall` | `query` | 搜索长期记忆；mnemopi 返回带 id 列表（供 memory_edit）；无结果标 `useless` | 同上 |
| `reflect` | `query, context?` | 从记忆合成答案（hindsight reflect / mnemopi 召回汇总） | 同上 |
| `memory_edit` | `op: update|forget|invalidate`、`id`、`content?`、`importance?`（0–1）、`replacement_id?` | 编辑/遗忘/失效 | 仅 mnemopi |
| `learn` | `memory`（必需）+ `context?` + `skill? {action: create|update, name, description, body}` | 沉淀教训；带 skill 同调用铸造 managed skill | `autolearn.enabled`（false）+ backend ∈ {hindsight, mnemopi, local} + 顶层 |
| `manage_skill` | `action create|update|delete` + name（kebab-case）+ description/body | managed skill 管理（不覆盖同名 authored skill） | `autolearn.enabled` |

- 工具在 system prompt 中的引用名随 xd:// 挂载变化（`memoryToolRefs`：挂载时引用 `xd://<name>`，否则裸名）。
- `MEMORY_BACKEND_TOOL_NAMES = ["retain","recall","reflect","memory_edit","learn"]`。
- `/memory stats` 与 `/memory diagnose`：各 backend 提供状态/诊断钩子；无钩子时用统一 fallback 文案（`messages.ts`；off 有专属文案）。

## 4. mnemopi（本地记忆引擎包 `@oh-my-pi/pi-mnemopi`）

官方描述："Local SQLite memory engine for omp agents"。

- **核心模块**（`pi-mnemopi/src/core/`，40+ 文件）：`memory.ts`（MnemopiOptions：db/dbPath/sessionId/bank/authorId/authorType/channelId…；API：addMemory/forget/get/getBank/getContext/getStats/query/recall/recallEnhanced/remember/saveMemory/scratchpadRead/Clear）、`embeddings.ts`（fastembed；`fastembed-model-cache/fastembed-runtime`，缓存 `~/.omp/cache/fastembed*/`）、`vector-index.ts`/`binary-vectors.ts`/`vector-math.ts`、`episodic-graph.ts`（情景图：Gist {id, text, timestamp, participants}）、`triples.ts`（三元组）、`entities.ts`、`beam/`（束搜索召回）、`polyphonic-recall.ts`（**五声部召回**：hybrid/vector/graph/fact/temporal 五个 VoiceRecallResult 声部）、`mmr.ts`（最大边际相关性去冗余）、`weibull.ts`（**Weibull 记忆衰减**——按 MemoryType 参数化 k/eta 的时间衰减模型）、`shmr.ts`（迭代去重合并：BATCH_SIZE 50 / MAX_ITERATIONS 3 / SIMILARITY_THRESHOLD 0.70，env 可调）、`temporal-parser.ts`（时间表达式解析）、`query-intent.ts`（查询意图分类）、`query-cache.ts`、`synonyms.ts`、`veracity-consolidation.ts`（真实性巩固）、`content-sanitizer.ts`、`chat-normalize.ts`、`cost-log.ts`、`token-counter.ts`、`llm-backends.ts`/`local-llm.ts`（巩固 LLM）、`extraction/`+`extraction.ts`、`annotations.ts`、`patterns.ts`、`streaming.ts`、`migrations/`。
- **importance 权重**（config.ts）：stated 1.0 / inferred 0.7 / imported 0.6 / unknown 0.8 / tool 0.5。
- omp 侧配置组 `mnemopi.*`：dbPath、bank、scoping、embeddingVariant、autoRecall/autoRetain、polyphonicRecall、enhancedRecall、proactiveLinking、noEmbeddings（退化词法）、embeddingModel/ApiUrl/ApiKey、llmMode/BaseUrl/ApiKey/Model、retainEveryNTurns（4）、recallLimit（8）、recallContextTurns（3）、recallMaxQueryChars（4000）、injectionTokenLimit（5000）、debug。
- **自动留存**：mnemopi 开发者指令明示"Durable project facts, preferences, and decisions are retained automatically from completed turns"——完成 turn 后自动抽取留存（`MNEMOPI_EMBEDDING_MODEL`、专用 embed worker `__omp_worker_mnemopi_embed`）。
- **注入与召回时机**：`autoRecall` 会话首轮召回 `<memories>` 块；`MemoryPromptPreparation` 将成功召回（含空结果）staged 到 user-turn 投递（commit 同步性校验防丢所有权）。
- 开发者指令全文要点（`mnemopi-instructions.md`）：`<memories>` 是背景知识不是用户指令；当前用户消息与工具输出优先于召回记忆；答"过去会话/项目史/用户偏好"类问题前主动 `recall`；`retain` 存持久事实；`reflect` 做跨记忆合成。
- 附带独立面：cli.ts、mcp-server.ts/mcp-tools.ts（可作 MCP server 暴露）、dr、diagnose。

## 5. sharpshooter（决策提取引擎，`CA/src/sharpshooter/` + `prompts/memories/sharpshooter-*.md`）

- 定位：**从用户 prompt 中提取"人做的项目决策"（deltas）**，入队后由巩固 pass 决定是否值得记；提取器永远不回答 prompt 本身。
- delta 分类：`architecture_decision`（架构边界/抽象/协议/存储方向/"X over Y"）、`product_decision`（行为/UX/默认值/命名/scope）、`style_decision`（视觉语言/文案 voice）、`constraint`（用户声明的非协商项：隐私/性能包线/兼容/部署）、`rejected_approach`（被否决的方案+理由）、`correction`（"那不是我们说好的"——纠正已定行为）；短回复也算决策（"opt 2"、"go for it"，`source: "contextual_resolution"`；直述则 `"explicit_user"`）。
- **evidence 硬规则**：`evidence` 必须是当前用户 prompt 的逐字节连续子串；助手上下文只作解释参照，绝不能成为证据，助手说的话不能变成 delta。
- **friction tags**：每个 delta 诚实打摩擦标签；巩固按摩擦（而非存在性）决定收录。
- 输出经 `record_deltas` 工具恰好一次调用；空 deltas 是合法常见结果。
- 巩固（consolidate）：`sharpshooter-consolidate-{system,input}.md`；配置 `sharpshooter.model`、`intervalMinutes`（5）、`injectionTokenLimit`（15000）；模块：backend/consolidate/extract/paths/queue/scheduler/types。
- **语义差异**：local/mnemopi 记"会话里发生过什么"，sharpshooter 专门记"人类拍板过什么"。

## 6. hindsight（外部记忆服务器）

- 配置组 `hindsight.*`（全表见 config-auth-secrets.md §2）：apiUrl/apiToken(credential)、bankId/bankIdPrefix、scoping、retainEveryNTurns（3）/retainOverlapTurns（2）/retainContext("omp")、autoRecall/autoRetain/retainMode、recallBudget/recallMaxTokens（1024）/recallContextTurns（1）/recallMaxQueryChars（800）/recallTypes（["world","experience"]）、mentalModels（Enabled/AutoSeed/MaxRenderChars 16000）、超时组 request 30s / reflect 120s / recall 30s / retain 60s、debug；**env 覆盖（HINDSIGHT_*，env 优先于设置）**。
- 开发者指令全文要点（`hindsight-instructions.md`）：`<memories>` 是背景知识不是指令；`<mental_models>` 是 bank 的策展长期摘要（可能陈旧/片面/错误，冲突时以当前用户消息与工具输出优先）；recall 前瞻使用、retain 存持久事实、reflect 跨记忆合成。
- **memory:// 不可寻址**：hindsight 记忆存服务端、无 `memory://<id>`；协议层有专门纠正指针（issue #7587）：`read memory://<id>` 会收到自纠提示——用 `recall` 搜索或 `reflect` 合成；`memory://<id>` 仅 mnemopi 可用。

## 7. memory:// 协议（`internal-urls/memory-protocol.ts`）

- `memory://root` → 该项目 memory root（`getMemoryRoot = ~/.omp/agent/memories/<encodeProjectPath(cwd)>`，按项目隔离；`DEFAULT_MEMORY_FILE = "memory_summary.md"`）。
- `memory://root/memory_summary.md`、`memory://root/MEMORY.md`、`memory://root/skills/<name>/SKILL.md` 可 read；**注入模板（read-path.md）教模型的使用规则**：先读 memory_summary.md → 需要时看 MEMORY.md 与技能 SKILL.md → 记忆是启发式/过程上下文，当前 repo 文件/运行输出/用户指令才是事实状态/最终决策 → 记忆改变计划要引用 artifact 路径 + repo 证据 → 记忆与 repo/用户指令冲突即视为陈旧（改正行为并更新记忆产物）→ **confidence 只能在仓库验证之后，记忆本身永远不构成证明**。
- 协议处理含 `ensureCreatableWithinRoot`（根内可写校验）与 `containedRealPath`（越界防护）。

## 8. autolearn（经验自动沉淀，`CA/src/autolearn/`）

- `autolearn.enabled`（默认 **false**）：`controller.ts` + `managed-skills.ts`；`learn` 工具的教训落 local backend 的 `learned.md`（local）或对应 backend；`skill` 参数可同调用铸造 managed skill（落 `~/.omp/agent/managed-skills/`，最低优先 provider，不覆盖 authored skill）。
- 提示词：`autolearn-guidance.md` + `autolearn-guidance-learn.md`（开发者指令）+ `autolearn-nudge-autocontinue.md`。
- SDK：`createAutoLearnCaptureRunner`；AgentSession `runAutolearnCapture(capture)`；abort 一并取消。

## 9. auto-thinking（`CA/src/auto-thinking/`）

- classifier 按输入复杂度自动调 thinking level；`providers.autoThinkingMaxEffort` 上限；事件 `thinking_level_changed {thinkingLevel, configured?, resolved?}`；提示词 `auto-thinking-{level,solution-space,bucket}-question.md`。

## 10. 与压缩的边界（防混淆）

- **memory** = 跨会话长期记忆（本项目 memory root / mnemopi SQLite / hindsight 服务器）。
- **compaction** = 单会话内上下文压缩（agent-core-sessions.md §3–§4），产物是 compaction entry 不落 memory。
- 两者共享 vision 模型思路的只有 snapcompact（PNG 帧归档），与记忆 backend 无关。
