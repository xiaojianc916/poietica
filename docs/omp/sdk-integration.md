# oh-my-pi（omp）SDK 直接集成深度调研报告

> 视角：以 npm 包 `@oh-my-pi/pi-coding-agent` 作为**库**（SDK）在你的进程内直接驱动编码 agent —— `createAgentSession()` → `session.prompt()` → `session.subscribe()`。
> 来源：仅官方 —— ① 随 npm 发布的官方 TypeScript 源码 18.3.0（`CA/` = 包根，`PAC/` = pi-agent-core，`PI_AI/` = pi-ai，`PI_CAT/` = pi-catalog，`SC/` = snapcompact，`NAT/` = pi-natives）；② 官方 SDK 示例 `CA/examples/sdk/`（14 个）；③ 官方扩展/钩子示例 README；④ npm registry 元数据（最新 18.4.3）；⑤ GitHub 官方 README 与 omp.sh/docs。
> 与进程内 SDK 集成无关的内容（ACP 编辑器协议、交互 TUI 专属机制、CLI 子命令表、主题系统、collab/live 分享等）已从本版报告移除；与本视角相关的章节全部加深到**方法签名与选项语义**级。

## 目录

1. 总览与安装
2. SDK 导出面（index.ts 全导出）
3. `createAgentSession()` 全选项详解
4. `createAgentSession()` 返回值与发现助手
5. AgentSession API（驱动 / 状态 / 事件 / 会话操作 / 结构化输出 / 生命周期）
6. SessionManager API（持久化 / 树 / artifact / 存储后端）
7. ModelRegistry 与 AuthStorage（模型发现 / 凭据 / 轮换）
8. Settings API（读取 / 覆盖 / 热重载）
9. 工具系统（ToolSession / custom tools / 审批 / xd:// 预览流）
10. 扩展 API（ExtensionFactory / ExtensionAPI 全成员 / 事件返回值协议）
11. Agent 循环语义（队列 / 中断 / stopReason / 投机执行）
12. 上下文维护（压缩五方法 / TTSR / 投机压缩）
13. 系统提示词与上下文文件
14. 模型接入层要点（provider / thinking / 重试 / usage）
15. 会话持久化格式（JSONL / 16 种 entry / 树）
16. 代码智能工具（LSP / DAP / hashline 编辑 / AST / 安全扫描）
17. Web / 浏览器 / 桌面 / 语音工具
18. 记忆 / Advisor / Goals / auto-thinking
19. task / subagent 体系（SDK 建 subagent）
20. MCP 支持（enableMCP / MCPManager API）
21. RPC 嵌入备选（RpcClient）
22. SDK 相关环境变量
23. 遥测（telemetry 选项）
24. 安全要点（审批 / secrets / 围栏）
25. 官方示例清单
26. 关键数字速查

---

## 1. 总览与安装

**定位**："A coding agent with the IDE wired in" —— Pi 的深度 fork，把 LSP、DAP 调试器、结构化编辑、安全扫描编进 agent 本体；本报告聚焦它的**库形态**。

| 项 | 值 |
|---|---|
| 包名 | `@oh-my-pi/pi-coding-agent`（bin: `omp`，SDK 入口 `src/index.ts`） |
| 版本 | 本报告锚定 18.3.0（源码随 npm 发布，可直接读）；npm 最新 18.4.3 |
| 运行时 | **Bun ≥ 1.3.14**（硬校验，`CA/src/cli.ts`）；TypeScript 直接 import（无 dist 依赖） |
| 依赖闭包 | pi-ai（统一 LLM API）、pi-agent-core（循环内核）、pi-catalog（5510 模型目录）、pi-tui（TUI 组件，SDK 亦导出部分）、pi-natives（Rust N-API 二进制，平台 optionalDependencies）、omnitype（arktype/typebox/zod）、pi-utils |
| License | MIT（vendored brush-shell 等保留上游许可） |
| 卸载形态 | SDK 会话默认把会话写盘到 `~/.omp/agent/sessions/`（可换 `SessionManager.inMemory()` 或自定义 storage） |
| 配置 | 默认读 `~/.omp/agent/config.yml`（settings）与 `~/.omp/agent/models.yml`（自定义 provider）——均可整体替换/禁用 |

**最小用法**（官方 `examples/sdk/01-minimal.ts` 全文）：

```ts
import { createAgentSession } from "@oh-my-pi/pi-coding-agent";

const { session } = await createAgentSession();

session.subscribe(event => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
});

await session.prompt("What files are in the current directory?");
session.state.messages.forEach(msg => console.log(msg));
```

默认行为：从 `cwd` 与 `~/.omp/agent` 发现 skills、hooks/扩展、tools、AGENTS.md 上下文文件；模型从 settings 或首个可用凭据选择；会话持久化到默认 sessions 根。

---

## 2. SDK 导出面（`CA/src/index.ts` 全导出，按主题分组）

```ts
// ── 会话与 SDK 核心 ──
export * from "./sdk";                          // createAgentSession、discover* 助手、工具类
export * from "./session/agent-session";        // AgentSession + 全部事件类型
export * from "./session/session-manager";      // SessionManager + 存储后端
export * from "./session/auth-storage";         // AuthStorage 再导出（实现在 pi-ai）
export * from "./config/model-registry";        // ModelRegistry
export { Settings, settings } from "./config/settings";
export * from "./session/session-entries";      // 16 种 SessionEntry 类型
export * from "./session/session-loader";       // 打开/解析既有会话
export * from "./session/session-listing";      // 会话枚举
export * from "./session/session-context";      // SessionContext 构建
export * from "./session/session-dump-format";
export * from "./session/session-migrations";
export * from "./session/indexed-session-storage";
export * from "./session/sql-session-storage";
export * from "./session/redis-session-storage";
export * from "./session/messages";             // CustomMessage / SkillPromptDetails

// ── 工具 ──
export * from "./tools";                        // BUILTIN_TOOLS、HIDDEN_TOOLS、createTools、ToolSession、全部工具类与 details 类型

// ── 扩展 ──
export * from "./extensibility/extensions";     // ExtensionFactory / ExtensionAPI / 全事件类型
export * from "./extensibility/custom-tools";   // CustomTool / CustomToolAPI
export * from "./extensibility/skills";         // Skill / discoverSkills
export { type FileSlashCommand, loadSlashCommands as discoverSlashCommands } from "./extensibility/slash-commands";
export type * from "./extensibility/custom-commands/types";

// ── task / subagent ──
export * from "./task/executor";                // TaskExecutor
export type * from "./task/types";
export type { TaskItem, TaskParams, YieldItem, AgentProgress, ReviewFinding, ... } from "@oh-my-pi/pi-tui/tools/task";

// ── LSP ──
export type * from "./lsp";                     // LSP 配置/类型

// ── 模式层（程序化可用部分）──
export * from "./main";                         // runRootCommand 等（CLI 入口，可不用）
export * from "./modes";                        // 含 RpcClient（§21）、composer、planSaveFileName
export * from "./modes/components";             // Hook/Extension * 组件别名

// ── 校验与工具杂项 ──
export { z } from "@oh-my-pi/omptype/zod"; export * as zod from "@oh-my-pi/omptype/zod";
export { Container, Markdown, Spacer, Text } from "@oh-my-pi/pi-tui";   // 自定义工具 TUI 渲染
export * from "@oh-my-pi/pi-tui/app-keybindings";
export * from "@oh-my-pi/pi-tui/theme";
export * from "./config/prompt-templates";
export { getAgentDir, logger, VERSION } from "@oh-my-pi/pi-utils";
export * from "./utils/github";
```

> 注意：`extensions` 是旧 "hooks" 体系的新名字（官方示例 06-hooks.ts 明说 `"hooks" is now called "extensions" in the API`）；`createAgentSession` 选项 `extensions: ExtensionFactory[]` 即行内钩子/扩展。

---

## 3. `createAgentSession()` 全选项详解

接口：`CreateAgentSessionOptions`（`CA/src/sdk.ts`）。下表按主题穷尽列出全部选项 + 官方文档注释语义 + 默认值。

### 3.1 工作区与目录

| 选项 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `cwd` | string | `getProjectDir()` | 项目本地发现的根目录 |
| `additionalDirectories` | string[] | — | cwd 之外的工作区目录（multi-root，绝对或相对路径）；转发给 subagent |
| `agentDir` | string | `~/.omp/agent` | 全局配置/状态目录 |
| `localProtocolOptions` | LocalProtocolOptions | 会话自己的 artifacts 目录 + sessionId | 覆盖 `local://` 协议选项（subagent 共享场景） |

### 3.2 凭据与模型

| 选项 | 默认 | 语义 |
|---|---|---|
| `authStorage` | `discoverAuthStorage(agentDir)` | 凭据存储（§7.3） |
| `modelRegistry` | `discoverModels(authStorage, agentDir)` | 模型注册表（§7） |
| `getApiKey` | registry 常规 session-affine resolver | 请求级凭据解析窄缝：可在不改常规路由的情况下钉住某条凭据（安全扫描用此机制） |
| `credentialSourceSessionId` | — | 把来源会话的凭据亲和复制进本会话 |
| `model` | settings 默认模型，否则首个可用 | 直接传 Model 对象；**SDK 传入的 model 对象默认不参与发现后重绑定**（调用方持有的路由/限额保持权威） |
| `rebindModelAfterDiscovery` | false | 允许显式 model 在后台发现后重绑到同 selector 的 registry 条目（CLI 对 registry 解析出的模型开启） |
| `modelPattern` / `modelPatternAuthFallback` / `modelPatternFallbackRole` / `modelPatternDefaultFallbackChain` | — | 延迟模型解析：pattern 在扩展加载后再解析（扩展可能注册 provider）；配套 fallback 链 |
| `thinkingLevel` | settings | thinking selector（minimal/low/medium/high/xhigh/max/auto…） |
| `thinkingLevelCeiling` | — | thinking 硬上限（每次变更与 retry-fallback 恢复都重新 clamp） |
| `openAIServiceTier` | settings `tier.*` | OpenAI service tier；`null` 显式省略 `service_tier` |
| `resolveServiceTierByFamily` | — | `(model) => ServiceTierByFamily` 回调，初始模型确定后调用一次；结果持久化（resume 恢复） |
| `scopedModels` | — | 可循环切换的模型数组 `{model, thinkingLevel?}` |
| `prewalk` | — | todo 建立后首个 edit/write 处单向切到快模型 `{target, thinkingLevel?}` |
| `planYolo` | — | 只读 plan 启动 → 模型首次 resolve 自动批准 → 切执行模型 `{target, thinkingLevel?}` |
| `spawns` | `"*"` | 允许 spawn 的 agent 集 |

### 3.3 系统提示与 provider 侧标识

| 选项 | 语义 |
|---|---|
| `systemPrompt` | `string \| string[] \| ((defaultPrompt: string[]) => string \| string[])` —— 完整替换默认渲染块；函数式接收默认块返回修改版 |
| `systemPromptTemplate` | Handlebars 模板替换内置默认渲染 |
| `customSystemPrompt` | 已加载的自定义提示文本，走内置 custom 模板渲染 |
| `appendSystemPrompt` | 已加载的追加文本，走内置追加模板 |
| `titleSystemPrompt` | 会话标题自动生成的 system prompt 覆盖 |
| `providerSessionId` | provider 侧会话 id（prompt cache + sticky auth；本地会话文件仍隔离） |
| `providerPromptCacheKey(+Source)` | provider 侧 prompt cache key；`"explicit" \| "fork"` 标记来源 |
| `deadline` | Unix epoch ms 绝对截止时间（会话硬截止） |

### 3.4 工具 / 扩展 / 技能 / 上下文

| 选项 | 默认 | 语义 |
|---|---|---|
| `customTools` | 发现结果 | 注册自定义工具（`CustomTool \| ToolDefinition`；**传入即替换发现**） |
| `extensions` | — | 行内 ExtensionFactory（与发现合并） |
| `additionalExtensionPaths` | [] | 额外扩展文件路径（与发现合并） |
| `disableExtensionDiscovery` | false | 禁扩展发现（显式路径仍加载） |
| `preloadedExtensions` / `preloadedExtensionPaths` / `preloadedPreparedExtensions` / `preloadedCustomToolPaths` | — | 跳过文件系统扫描的优化通道；**严禁跨会话传递 Extension 实例**（闭包绑定父会话 API），subagent 用 `preloadedPreparedExtensions` 转发 |
| `extensionRoots` | — | 扩展根策略 provider（子会话继承显式根/发现模式） |
| `skills` | 多处发现 | Skill[]（传入即替换；`[]` 禁用） |
| `rules` | 多处发现 | Rule[]（TTSR/always-apply 规则） |
| `contextFiles` | 从 cwd 向上发现 | `{path, content}[]`（AGENTS.md 内容；可注入虚拟文件） |
| `workspaceTree` | — | 预构建工作区树（父传子免重扫） |
| `promptTemplates` | `cwd/.omp/prompts/` + `agentDir/prompts/` | 提示模板 |
| `slashCommands` | commands/ 目录发现 | 文件型斜杠命令 |
| `toolNames` | 全部内置工具 | 显式请求的工具名（**可启用默认关闭的工具**，如 security_scan/generate_image） |
| `restrictToolNames` | false | 严格模式：只保留显式列出的工具（无发现附加） |
| `allowRestrictedCustomTools` | false | 受限会话内允许调用方 SDK 自定义工具（仍须列入 toolNames；扩展/MCP/环境发现的自定义工具保持禁用） |

### 3.5 会话与执行

| 选项 | 默认 | 语义 |
|---|---|---|
| `sessionManager` | 存到 agentDir sessions 根 | `SessionManager`（§6：inMemory/create/continueRecent/open） |
| `settings` | `Settings.init({cwd, agentDir})` | Settings 实例（§8）；`settingsManager` 为 legacy 别名 |
| `eventBus` | 新建 | 工具/扩展共享事件总线 |
| `subagentEventBus` | 根会话新建 | 根作用域总线：本会话树全部 `task:subagent:*` 观测帧 |
| `enableMCP` | true | false 跳过 MCP 发现并忽略 `mcpManager`（阻断进程级/继承的 MCP） |
| `mcpManager` | — | 复用既有 MCPManager（跳过发现，传播给 toolSession） |
| `enableLsp` | true | LSP 工具/格式化/诊断/预热 |
| `lspReadOnly` | 受限会话默认 true | LSP 限制为导航+诊断 |
| `enableIrc` | — | 是否暴露 IRC（subagent 可被强制移除） |
| `skipPythonPreflight` | false | 跳过子进程内核可用性检查与 prelude 预热 |
| `hasUI` | **false** | 有 UI（启用 ask 等交互工具）；SDK 无头集成为 false |
| `interactivePrompts` | = hasUI | 无终端 UI 但有真人可应答同步提示（编辑器 elicitation 场景）；启用 ask 但不启用 TUI 专属行为 |
| `autoApprove` | false | 自动批准所有工具调用 |
| `deferUsageReserveConfirmation` | false | 推迟 usage-reserve fallback 的 confirm 到 prompt 时 UI 配置好之后 |
| `telemetry` | — | GenAI 语义约定 OTel 插桩；`{}` 即启用（未注册 OTEL SDK 时为 no-op tracer，安全） |
| `onFirstChatDispatch` | — | 首次把请求交给 provider transport 时触发一次（测"会话建成→模型调用"延迟） |

### 3.6 结构化输出 / subagent

| 选项 | 语义 |
|---|---|
| `outputSchema` | 结构化完成的 JSON Schema；session 注册 `yield` 工具，其参数按 schema 动态生成并严格校验 |
| `outputSchemaMode` | `"permissive"`（legacy 默认）\| `"strict"` 校验策略 |
| `requireYieldTool` | 默认包含 yield 工具 |
| `taskDepth` | 0（顶层）；subagent 会话递增（抑制 live 记忆 backend 替换等） |
| `parentHindsightSessionState` / `parentMnemopiSessionState` | 子代理别名父会话记忆状态 |
| `agentId` / `agentDisplayName` / `agentName` / `agentRegistry` | IRC 路由身份；默认顶层 "Main"/"main" |
| `parentTaskPrefix` / `parentAgentId` / `parentEvalSessionId` | 嵌套 artifact 命名前缀 / 注册表父链接 / 共享父 eval 内核状态 |

> 注释明示：`advisorGetToolContext` 类桥工具无 context 时 **fail-closed 到 always-ask 空策略**——无头 SDK 集成若需要免审批必须显式 `autoApprove: true` 或提供审批通道。

---
## 4. 返回值与发现助手

### 4.1 `CreateAgentSessionResult`

| 字段 | 语义 |
|---|---|
| `session` | AgentSession（§5） |
| `extensionsResult` | `LoadExtensionsResult`（加载的扩展 + runner） |
| `setToolUIContext(uiContext, hasUI)` | 事后接通扩展 UI 通道（交互宿主用；无头宿主可借此接自定义 UI 实现） |
| `mcpManager?` | MCP 管理器（enableMCP=false 时 undefined） |
| `modelFallbackMessage?` | 恢复会话时模型与保存不一致的警告 |
| `lspServers?` | 检测到的 LSP server（后台预热可继续） |
| `startBackgroundModelDiscovery?` | 首帧后启动缓存感知在线模型发现（返回 Promise） |
| `eventBus` | 工具/扩展共享总线 |
| `subagentEventBus?` | 根作用域子代理观测总线 |

### 4.2 发现助手（`CA/src/sdk.ts` 导出函数）

| 函数 | 签名要点 |
|---|---|
| `discoverAuthStorage(agentDir?, options?)` | 加载有效账号策略（`auth.accountPolicies`、`retry.usageReservePct`：options.settings → 全局实例 → 按 cwd 只读加载，显式值优先）后构建 AuthStorage（`CA/src/sdk.ts:779`） |
| `discoverModels(authStorage, agentDir?)` | 内置目录 + `models.yml` + OAuth 发现（ModelRegistry.create 的发现封装） |
| `discoverExtensions(cwd?)` | → `LoadExtensionsResult`（extensions 数组带 factory，可 `extensions: [...discovered.extensions.map(e => e.factory), myFactory]` 合并） |
| `discoverSessionExtensionPaths(...)` | 扩展源路径发现 |
| `discoverSkills(cwd?, agentDir?, filter?)` | → `{skills, warnings}`；filter 支持 `ignoredSkills[]`（glob 排除）、`includeSkills[]`（glob 包含，空=全部）（`CA/src/sdk.ts:889`） |
| `discoverContextFiles()` | AGENTS.md walk-up 发现 → `{path, content}[]` |
| `discoverPromptTemplates(cwd?, agentDir?)` | 提示模板发现 |
| `discoverSlashCommands(cwd?)` | 文件斜杠命令发现 |
| `discoverCustomTSCommands(cwd?, agentDir?)` | TS 自定义命令发现 |
| `discoverMCPServers(cwd?)` | MCP server 发现 → `MCPToolsLoadResult` |
| `buildSystemPrompt(...)` | 独立构建系统提示（预览用） |
| `createTools(toolSession, names?)` | 独立装配工具（SDK README 示例：ast_edit 存在时自动附 write） |
| `customToolToDefinition(...)` | CustomTool → ToolDefinition |
| `resolveDialect(...)` | in-band tool calling 方言解析 |

---

## 5. AgentSession API（`CA/src/session/agent-session.ts`，公开面穷尽）

### 5.1 驱动会话

```ts
prompt(text, options?: PromptOptions): Promise<boolean>
steer(text, images?: ImageContent[], options?: SteerOptions): Promise<void>
followUp(text, images?: ImageContent[], options?: FollowUpOptions): Promise<void>
sendUserMessage(content, options?: SendUserMessageOptions): Promise<...>
runEphemeralTurn(args: EphemeralTurnOptions): Promise<EphemeralTurnResult>
abort(options?): Promise<void>
```

**PromptOptions 全字段**（`agent-session-types.ts`）：
- `expandPromptTemplates?: boolean`（默认 true）——是否展开文件型提示模板；
- `images?: ImageContent[]` —— 图片附件；
- `streamingBehavior?: "steer" | "followUp" | "aside"` —— 流式中到达的行为；**流式中未指定则抛 `AgentBusyError`**；`"aside"` 为非中断注入（下一步边界，不打断在跑的工具批）；
- `toolChoice?: ToolChoice` —— 下一次 LLM 调用的工具选择覆盖；
- `synthetic?: boolean` —— 作为 developer/system 消息发送而非 user；
- `userInitiated?: boolean` —— 是否用户主动行为；
- `attribution?: MessageAttribution` —— 计费/发起方归因；
- `skipCompactionCheck?: boolean` —— 跳过发送前压缩检查。

返回 `Promise<boolean>`（prompt 是否被接受入队/开 turn）。

**SteerOptions / FollowUpOptions**：`attribution`；followUp 另有 `synthetic`（隐藏 developer 消息）、`expandPromptTemplates`。`SendUserMessageOptions`：`deliverAs?: "steer" | "followUp" | "aside"`（省略 = idle 开 turn、流式中 steer）+ `attribution`。

**语义要点**：
- 流式中 prompt（无 streamingBehavior）→ `AgentBusyError`；应改用 steer/followUp 或带 `streamingBehavior` 的 prompt。
- steering/followUp 队列行为由 `steeringMode/followUpMode`（§11）控制；abort 后未投递消息回队首。
- `setPromptDropped(handler)`：prompt 在入 agent 前被取消（abort 或 usage preflight 拒绝竞态）时的回调（`DroppedPrompt {text, images?}`）——未持久化的 prompt 不会进会话。

### 5.2 事件订阅

```ts
subscribe(listener: AgentSessionEventListener): () => void   // 返回退订函数
subscribeRunState(listener: (state: "running" | "idle") => void): () => void
subscribeCommandMetadataChanged(listener): () => void
activeToolExecutionUpdates(): readonly ToolExecutionUpdateEvent[]   // 当前在跑工具的更新快照
```

**AgentSessionEvent 全型**（`CA/src/session/agent-session-events.ts`，71 行全文核对）：

核心（继承 pi-agent-core AgentEvent）：
- `agent_start`
- `agent_end {messages, telemetry?, coverage?, isTerminal?}` —— `isTerminal:false` 表示异步投递稍后还会 resume（非真正终态）
- `turn_start` / `turn_end {message, toolResults}`（一个 turn = 一次 assistant 响应 + 其工具调用/结果）
- `message_start {message}` / `message_update {message, assistantMessageEvent}` / `message_end {message}` —— message_update 携带底层流事件（`text_delta`/`thinking_delta`/`toolcall_start|delta|end`/`image_end`…）
- `tool_execution_start {toolCallId, toolName, args, intent?}` / `tool_execution_update {…, partialResult}` / `tool_execution_end {toolCallId, toolName, result, isError?}`
- `tool_stream_update {toolCallId, toolName, update}` —— `openArgStream` 流式参数投影（如 edit 实时 diff 预览）

会话级扩展事件：
- `auto_compaction_start {reason: "threshold"|"overflow"|"idle"|"incomplete", action: "context-full"|"remote"|"handoff"|"shake"|"snapcompact"}`
- `auto_compaction_end {action, result: CompactionResult|undefined, aborted, willRetry, errorMessage?, skipped?}`
- `auto_retry_start {attempt, maxAttempts, delayMs, errorMessage, errorId?}` / `auto_retry_end {success, attempt, finalError?, retryErrors?}`
- `retry_fallback_applied {from, to, role, reason?}` / `retry_fallback_succeeded {model, role}`
- `model_changed` / `config_warnings_changed`
- `advisor_cost_changed` / `advisor_yielded`
- `thinking_level_changed {thinkingLevel, configured?, resolved?}`（auto 分类的解析结果）
- `ttsr_triggered {rules: Rule[]}` / `todo_reminder {todos, attempt, maxAttempts}` / `todo_auto_clear`
- `irc_message {message: CustomMessage}` / `notice {level: info|warning|error, message, source?}`
- `goal_updated {goal: Goal|null, state?: GoalModeState}`

### 5.3 状态与查询（getter 全表）

`state: AgentState`（systemPrompt[]、model、thinkingLevel、tools、messages、isStreaming、pendingToolCalls、error）、`model`、`servingModel`（含 fallback 归属）、`thinkingLevel`、`configuredThinkingLevel()`、`isAutoThinking`、`autoResolvedThinkingLevel()`、`serviceTierByFamily`、`isStreaming`、`isAborting`、`waitForIdle()`、`isDisposed`、`isCompacting`、`compactionSpeculation("idle"|"running"|"armed")`、`isRetrying`、`isGeneratingHandoff`、`isBashRunning`、`isEvalRunning`、`sessionFile`、`sessionId`、`sessionName`、`messages`、`getLastAssistantMessage()`、`systemPrompt: string[]`、`scopedModels`、`steeringMode`/`followUpMode`/`interruptMode`、`queuedMessageCount`、`getQueuedMessages(): {steering, followUp}`、`retryAttempt`、`autoRetryEnabled`、`autoCompactionEnabled`、`hasEditTool`、`getActiveToolNames()/getEnabledToolNames()/getMountedXdevToolNames()/getAllToolNames()/getAllToolInfos()`、`hasBuiltInTool(name)`、`getToolByName(name)`、`skills`/`renderedSkills`/`skillWarnings`、`slashCommands`/`customCommands`/`mcpPromptCommands`、`promptTemplates`、`getTodoPhases()`、`getSessionStats(): SessionStats`（userMessages/assistantMessages/toolCalls/tokens{input,output,reasoning,cacheRead,cacheWrite,total}/premiumRequests/cost/credits/routedModels/contextUsage）、`getContextBreakdown(): ContextUsageBreakdown`（contextWindow/anchored/usedTokens/systemPromptTokens/systemToolsTokens/systemContextTokens/skillsTokens/messagesTokens）、`providerSessionState`、`getCheckpointState()`、`getPlanModeState()/getPrewalkState()/getGoalModeState()`。

### 5.4 模型与 thinking 运行时控制

```ts
setModel(selector) / setModelTemporary(...) / cycleModel(direction) / applyRoleModel(entry)
cycleRoleModels(...) / getRoleModelCycle(roleOrder) / resolveRoleModel(role)
getAvailableModels(): Model[]
setThinkingLevel(level, persist=false) / cycleThinkingLevel() / getAvailableThinkingLevels()
setServiceTierFamily(family, tier) / setFastMode(enabled) / toggleFastMode() / isFastModeActive()
setScopedModels([...]) / setUsageFallbackConfirmer(confirmer)   // usage-reserve fallback 确认回调
```

### 5.5 会话操作

```ts
newSession(options?) : Promise<boolean>            // FreshSessionResult {previousSessionId, sessionId, closedProviderSessions}
fork(): Promise<boolean>                            // 完整 fork（providerPromptCacheKey 继承）
branch(entryId): Promise<...>                       // 从历史节点分叉
branchFromBtw(...) / navigateTree(targetId, {summarize, customInstructions, allowAskReopen, reanswerAskResult})
getUserMessagesForBranching(): {entryId, text}[]
switchSession(...) / moveSession(newCwd, targetSessionDir?)
setSessionName(name, source) / generateTitle(...) / maybeStartTitleGeneration(firstMessage)
compact(customInstructions?, options?) : Promise<CompactionResult>
shake(mode, opts?) : Promise<ShakeResult> / runIdleCompaction()
setAutoCompactionEnabled(enabled, persist=false) / abortCompaction(reason?)
handoff(customInstructions?, options?) : Promise<HandoffResult|undefined>   // {document, savedPath?}
abortHandoff() / abortBranchSummary()
retry() / abortRetry() / setAutoRetryEnabled(enabled, persist)
resetSessionContext() : Promise<ResetSessionContextResult>   // /clear 等价：{droppedCount}
freshSession() / dropImages(): Promise<{removed}>
```

### 5.6 工具 / 队列 / bash / eval 直控

```ts
setActiveToolsByName(toolNames) / setToolBuiltIn(name, builtIn) / setExtensionMCPTool(name, tool?)
setThinkToolEnabled(enabled) / refreshSkills() / refreshMCPTools(tools) / refreshBaseSystemPrompt()
setMCPPromptCommands(commands) / setSlashCommands(commands) / setTodoPhases(phases)
initializeCodeMode() / getCodeModeDirectToolNames() / getEvalPreludes()
activateVibeTools(base) / deactivateVibeTools(next)          // 动态装卸 vibe 工具集
clearQueue({forInterrupt?}) / popLastQueuedMessage(): RestoredQueuedMessage|undefined
executeBash(...) / recordBashResult(...) / abortBash()
executePython(...) / recordPythonResult(...) / abortEval() / assertEvalExecutionAllowed()
```

### 5.7 生命周期

```ts
beginDispose(): void
dispose(options?: AgentSessionDisposeOptions): Promise<void>
  // AgentSessionDisposeOptions { mnemopiConsolidateTimeoutMs?, drainTimeoutMs?(默认5s), reason?(postmortem.Reason) }
settleAsyncWork() / hasPendingAsyncWork() / settleInFlightMessagePersistence()
waitForAdmittedSubmissions() / prepareForHeadlessAdvisorDrain() / waitForAdvisorCatchup(timeoutMs)
```

> 无头集成收尾序列建议（由源码语义导出）：`abort()`（如需要）→ `waitForIdle()` → `settleAsyncWork()` → `dispose()`。信号路径与 `/quit` 走同一 teardown；`reason` 字段决定落盘的 `session_exit` 诊断文案。

### 5.8 侧 turn（/btw 等价，不入会话史）

```ts
runEphemeralTurn(args: EphemeralTurnOptions): Promise<EphemeralTurnResult>
```
- `EphemeralTurnOptions`：`promptText`、`history?`（前置相关侧 turn 消息，拷贝不入史）、`conversationKey?`（provider 谱系键；取消/失败后重试前应轮换）、`tools?: false`（省工具定义且禁止工具调用；Cursor 等强制原生工具的传输会前置拒绝）、`maxTokens?`（正整数输出上限；budget-thinking 模型上会禁用可选 thinking）、`maxContextBytes?`（序列化后 provider 上下文字节上限，transform 后、obfuscation 后测量）、`onTextDelta?`（顺序 await；失败拒绝并中止请求）、`signal?`、`dedupeReply?`。
- `EphemeralTurnResult`：`{replyText, assistantMessage}`。

### 5.9 扩展运行时句柄

`effectiveExtensionRoots`、`preparedExtensions`、`extensionPaths`、`registerSessionChangeCallback`、`setPlanProposalHandler`、`setClientBridge`、`queueDeferredMessage(message: CustomMessage)`、`deliverIrcMessage`、`drainPendingIrcInboxMessages`。

---

## 6. SessionManager API（`CA/src/session/session-manager.ts`，3783 行）

### 6.1 构造 / 打开

```ts
static create(cwd, sessionDir?, storage = new FileSessionStorage()): SessionManager   // 新会话
static createEmptySessionFile(cwd, storage?): string
static async open(...)                  // 打开既有会话文件
static async forkFrom(...)              // 从既有会话 fork 新文件
static async continueRecent(cwd, ...)   // 继续最近会话（无则新建）
static inMemory(...): SessionManager    // 纯内存（无持久化）
static async list(...) / listAll(storage?) / listForPicker(...) / listAllForPicker(...)   // 枚举
static getDefaultSessionDir(...)
static async peekSessionInit(...)       // 读 session_init 条目（subagent replay 用）
```

### 6.2 条目 / 树

`getEntries()/getBranch()`、`getEntry(id)`、`getLeafId()/getLeafEntry()`、`getChildren(parentId)`、`has(id)`、`entriesById()`、`childrenOf(id)`、`pathTo(id?)`、`tree(entries): SessionTreeNode[]`、`labelFor(id)`、`labelsInEffect()`、`setLeaf(id)`、`insert(entry)`、`rebuild(entries)`、`clear()`、`usageSnapshot()`。

追加 API（append 系列，全部返回 entry id）：`appendMessage`、`appendMessageToBranch`、`appendModelUsage`、`appendThinkingLevelChange`、`appendServiceTierChange`、`appendModeChange`、`appendModelChange`、`appendSessionInit`、`appendResetBoundary`、`appendCustomEntry(customType, data?)`、`appendTtsrInjection`、`appendCredentialPin`、`rewriteEntries()`（整文件原子重写）、`ingestReplicatedEntry`、`snapshotForReplication`。

### 6.3 持久化 / 文件管理

`getSessionDir()/getSessionId()/getSessionFile()`、`isSessionOnDisk()`、`ensureOnDisk()`、`flush()/flushSync()/close()/seal()`、`persistCopy(...)`、`setSessionFile(path)`、`newSession(options?)`、`dropSession(path)`、`fork()`、`moveTo(newCwd, targetSessionDir?)`、`recoverPersistenceFromCurrentState()`、`captureState()/restoreState(snapshot)`、`cloneCurrentSession({persist?})`、`rollbackMove(snapshot)`、`releaseRetainedEntries()`。

### 6.4 工作区 / 产物 / 草稿

`getCwd()/getRecordedCwd()/setCwdWithoutRelocation/adoptRecordedCwd()`、`getAdditionalDirectories()`、`addWorkspaceDirectory(dir)`、`removeWorkspaceDirectory(dir)`、`setAdditionalDirectories(dirs)`、`getArtifactsDir()`、`allocateArtifactPath(toolType)`、`saveArtifact(content, toolType): Promise<string|undefined>`、`getArtifactPath(id)`、`saveDraft(text)/consumeDraft()`。

### 6.5 用量 / 预算 / 标题

`getUsageStatistics()`、`beginTurnBudget(total, hard)`、`getTurnBudget()`、`recordEvalSubagentOutput(n)`、`getSessionName()`、`setSessionName(name, source, trigger?)`、`onSessionNameChanged(cb)`、`titleSource/titleRevision/reserveTitleRevision()`、`recordRecap(recap)`、`onPersistenceError(cb)`。

### 6.6 存储后端（可注入）

`FileSessionStorage`（默认，JSONL 同步落盘 + 文件锁 + 乐观并发 + 原子重写）、内存、`indexed-session-storage`、`sql-session-storage`、`redis-session-storage`（官方示例 12/13 演示 Redis 与 SQL 后端）。

---

## 7. ModelRegistry 与 AuthStorage

### 7.1 构造

```ts
const auth = await discoverAuthStorage(agentDir?, {settings?, cwd?, ...});
const registry = await discoverModels(auth, agentDir?);
// 完全自控：
const auth2 = await AuthStorage.create("/my/app/agent.db");       // 自定义 SQLite 位置
auth2.keys.setRuntime("anthropic", key);                          // 运行时 key（不落盘）
const reg2 = await ModelRegistry.create(auth2, "/my/app/models.json");  // null/省略 = 仅内置目录
```

### 7.2 ModelRegistry 方法（公开面）

- **查询**：`getAll(kind="chat")`、`getAvailable(kind)`（有有效凭据的）、`getAvailableForProviders(set, kind)`、`find(provider, modelId)`、`getProviderModels(provider)`、`getProviderBaseUrl(provider)`、`hasProvider(providerId)`、`hasConfiguredAuth(model)`、`hasConcreteAuth(provider)`、`hasCommandBackedApiKey(provider)`、`getDiscoverableProviders()`、`getProviderDiscoveryState(provider)`、`isProviderDiscoveryPending(provider)`。
- **刷新**：`refresh(...)`、`refreshInBackground(strategy="online-if-uncached")`、`awaitBackgroundRefresh()`、`awaitInitialBackgroundRefresh(signal?)`、`refreshProvider(provider, strategy)`、`refreshDiscoverableProviders(...)`、`refreshRuntimeProviders(strategy)`、`refreshSelectedModelMetadata(model)`、`hydrateCredentialScopedModelCaches()`、`reapplyModelPolicies()`、`getError(): ConfigError|undefined`。
- **凭据**：`getApiKey(...)`、`getApiKeyAndHeaders(model)`、`getApiKeyForProvider(...)`、`getApiKeyWithCredentialForProvider(...)`、`resolver(provider|model, options?)`（ApiKeyResolver 工厂；带 sessionId/baseUrl/modelId 维度）、`isUsingOAuth(model)`、`getProviderHeaders(provider)`、`resolveModelHeaders(model, signal?)`。
- **注册/注销（扩展 provider 注入点）**：`registerProvider(name, config, sourceId?)`、`unregisterProvider(name)`、`syncExtensionSources(activeSourceIds)`、`clearSourceRegistrations(sourceId)`。
- **熔断**：`suppressSelector(selector, untilMs)`、`isSelectorSuppressed(selector)`、`clearSuppressedSelector(s)`。

### 7.3 AuthStorage 九命名空间（`PI_AI/src/auth-storage.ts` + `auth/types.ts`）

```ts
auth.credentials   // 凭据行存储 + 变更事件
auth.keys          // 鉴权级联（见下）
auth.oauth         // login / access / accessAll / accessById / accounts / identity / policy / refresh
auth.sessions      // pin(provider, sessionId, credentialId) / inherit(source, target) / release — session-sticky 亲和
auth.usage         // reports / ingestHeaders / invalidate / history(query) / observe / recordClient / clientSummary / model(health)
auth.health        // check(options?) → CredentialHealthResult[]
auth.limits        // markReached / rotate(provider, sessionId) / invalidateMatching / list / redeem（reset 额度赎回）
auth.resets        // Codex/Claude reset 额度协调（进程级共享防双花，可注入替换——测试用）
auth.blocks        // 凭据/账号 block 清单
auth.getApiKey(provider, sessionId?, options?) / auth.reload() / auth.close()
```

**keys 命名空间（级联操作面）**：`get(provider, sessionId?, options?)`、`getWithCredential(...)`、`peek(provider)`、`source(provider, options?)`（首个活跃来源，不刷新）、`keyless(provider)`、`describe(provider, sessionId?)`、`setRuntime(provider, key)` / `removeRuntime`、`setConfig(provider, cfg)` / `removeConfig` / `clearConfig`、`setResolver(resolver)`、`resolver(provider, {sessionId?, baseUrl?, modelId?})`。

级联优先级：`runtime --api-key 等价物 → config(models.yml apiKey) → OAuth token → login key → env var → stored key(agent.db)`。

---

## 8. Settings API（`CA/src/config/settings.ts`）

```ts
static init(options?): Promise<Settings>        // 完整五层合并（defaults→global→project→overlay→runtime）
static loadReadOnly(options?): Promise<Settings>
static loadIsolated(options?): Promise<Settings> // 隔离实例（不共享全局单例）
static isolated(...)
get(path) / getGroup(group) / isConfigured(path)
override(path, value) / clearOverride(path)      // runtime 层（不持久化）
onEffectiveChange(listener: (path, value, prev) => void): () => void
set(path, value)                                 // 写回 config.yml（debounce、generation 比对防 clobber）
reloadFromDisk()                                 // 三路原子重读 global+project+overlay，重放 hooks
cloneForCwd(cwd) / reloadForCwd(cwd)
getGlobalSettings() / getProjectSettings() / getStorage() / getCwd() / getAgentDir() / revision
setModelRole(role, modelId) / setProjectModelRole / clearProjectModelRole / getEditVariantForModel(model)
getBashInterceptorRules() / getPlansDirectory() / getShellConfig() / extensionsSourceLevel()
cancelPendingSaves() / flush()
```

要点：约 480 个键（全表见上一版报告 §7.2，仍适用于 SDK——settings 决定压缩阈值、重试、工具门控、LSP、MCP 超时等全部默认行为）；`credential: true` 键永不打印/导出；subagent 派发前 `settings.reloadFromDisk()` 使外部 config.yml 修改对 SDK 会话内派生的子代理生效。

---
## 9. 工具系统（SDK 视角）

### 9.1 ToolSession 接口（`CA/src/tools/index.ts:178`，工具世界的依赖注入容器）

```ts
export interface ToolSession {
  cwd: string;
  additionalDirectories?: string[];      // multi-root，转发 subagent
  hasUI: boolean;                        // ask 等交互工具的前提
  canPromptUser?: boolean;               // ask 能否到达真人（默认 = hasUI）
  isDisposed?: () => boolean;
  suppressSpawnAdvisory?: boolean;       // 抑制 task 结果里的 spawn 建议（程序化消费结果时）
  fetch?: FetchImpl;                     // 注入 URL 读取管线（测试/代理）
  getApiKey?: AgentOptions["getApiKey"]; // 凭据解析转发给受限子会话
  getCredentialSourceSessionId?: () => string|undefined;
  skipPythonPreflight?: boolean;
  contextFiles? / workspaceTree? / skills? / promptTemplates? / rules? / activeRules?
  skillHintVisible?: boolean;            // skill:// 提示可见性快照（保证 prompt 前缀字节稳定）
  refreshSkills?: () => Promise<void>;
  extensionPaths? / preparedExtensions? / effectiveExtensionRoots? / customToolPaths?
  enableLsp? / lspReadOnly? / enableIrc? / enableMCP? / hasEditTool?
  eventBus? / subagentEventBus?
  outputSchema? / outputSchemaMode? / requireYieldTool? / prewalkArmed?
  restrictToolNames? / taskDepth?
  getSessionFile / sessionManager(Pick<SessionManager,…>) / getSessionId?
  getEvalSessionId? / getEvalKernelOwnerId? / getEvalPreludes? / assertEvalExecutionAllowed?
  trackEvalExecution?<T>(promise, abortController)
  getHindsightSessionState? / getMnemopiSessionState? / getAgentId?
  getToolByName? / getToolForEvalBridge? / getToolContext? / getEvalBridgeToolNames?
  getCodeModeDirectToolNames? / isToolActive? / setActiveToolNames? / toolRegistry? / xdev?
}
```

`createTools(toolSession, toolNames?)` 独立装配；`BUILTIN_TOOLS`（29 个工厂）与 `HIDDEN_TOOLS`（yield/goal/think）导出可自选。

### 9.2 内置工具与门控（速览；详细参数见 §16–§17 各工具节）

- **始终可用**（默认）：read、write、edit、task、bash、eval、lsp、debug、todo、grep、glob、web_search、ask（需 canPromptUser）、wait、ast_edit。
- **默认关闭，`toolNames` 显式启用**：github（+gh CLI）、security_scan、ast_grep、checkpoint+rewind（成对）、generate_image、tts（speechgen）。
- **条件可用**：find（judge 模型原生时 auto）、memory 组（retain/recall/reflect/memory_edit/learn/manage_skill，随 `memory.backend`/`autolearn.enabled`）、context_notes/new_context（实验上下文管理）、think/goal/yield（隐藏）。
- 详细门控表见上一版 §8.2（逻辑不变，仍适用于 SDK 会话）。

### 9.3 自定义工具（CustomTool / ToolDefinition）

两种形态均可传入 `customTools`：
- **ToolDefinition**（编程式，最轻）：`{name, label?, summary?, description, parameters(TypeBox/ArkType/zod schema), execute(toolCallId, params, onUpdate, ctx, signal): Promise<AgentToolResult>, approval?, loadMode?, concurrency?, deferrable?, strict?, intent?}`。
- **CustomTool**（文件式，带生命周期与 UI）：工厂 `(api: CustomToolAPI) => ToolDefinition`；文件放 `.omp/tools/`、`.claude/tools/`、插件等（发现可被 `customTools` 传入替换）。

**CustomToolAPI**（稳定跨会话变更）：

```ts
{
  cwd: string;
  exec(command, args, options?): Promise<ExecResult>;
  ui: CustomToolUIContext;               // select/confirm/input/notify/custom…
  hasUI: boolean;                        // print/RPC/无头为 false
  logger;                                // 文件 logger
  typebox / arktype / zod;               // 三种 schema 构建器注入
  pi: typeof PiCodingAgent;              // 整个 SDK 导出面
  pushPendingAction(action: CustomToolPendingAction): void;
  // CustomToolPendingAction { label, apply(reason), reject?(reason), details?, sourceToolName? }
  //   → 隐藏 resolve 工具消费：预览-接受流（ast_edit 同款）
}
```

**execute 上下文（CustomToolContext）**：`sessionManager`（只读）、模型信息等。**状态持久化模式**（官方 README）：工具结果 `details` 字段会进会话条目，分支/重放时经 `session_start` 事件从 `ctx.sessionManager.getBranch()` 重建状态——树导航安全的状态恢复模式。

### 9.4 审批在无头 SDK 下的行为

三层合并（工具 decision → `tools.approval.<tool>` → `tools.approvalMode`）不变；关键点：
- 缺 settings 时 fail-closed 为 `always-ask`；`hasUI:false` 且无审批通道时需要 prompt 的调用将无法执行；
- 无头自动化：`autoApprove: true`（全部放行）或 settings `tools.approvalMode: "yolo"` / `tools.approval.<tool>: "allow"` 精细放行；或经扩展 `tool_call` 事件编程裁决（返回 `{block: true, reason}` 或放行）；
- `event.tool_approval_requested / tool_approval_resolved` 事件可观测审批流；`setToolUIContext` 可注入自定义 UI 实现（自定义审批弹窗的接入口）。

### 9.5 ast_edit 预览-接受流（官方 SDK README 专节）

`ast_edit` 现在总是返回预览；定稿用 `write` 工具写虚拟设备：`xd://resolve`（body=理由 → 应用）与 `xd://reject`（→ 丢弃）。`createAgentSession()/createTools()` 在存在 deferrable 工具时**自动包含 write**，设备恒可达。示例：

```ts
const tools = await createTools(toolSession, ["ast_edit"]);
const writeTool = tools.find(t => t.name === "write")!;
await writeTool.execute("call-1", { path: "xd://resolve", content: "Preview matches" });
```

---

## 10. 扩展 API（ExtensionFactory / ExtensionAPI）

### 10.1 形态与装载

- **行内**：`extensions: [ (pi: ExtensionAPI) => {...} ]`（与发现合并）。
- **文件**：默认导出 `(pi: ExtensionAPI) => void` 的 TS 模块；发现路径 `~/.omp/agent/extensions/`、`<cwd>/.omp/extensions/`、settings `extensions[]`、`additionalExtensionPaths`；加载用原生 Bun import（支持外部依赖，jiti 模块解析——官方 chalk-logger/with-deps 示例）。
- 每个 `Extension` 实例**绑定其会话的 ExtensionAPI**（cwd、eventBus、runtime）——不可跨会话复用实例；subagent 转发用 `preloadedPreparedExtensions`。

### 10.2 ExtensionAPI 全成员（`CA/src/extensibility/extensions/types.ts:1216`）

**注入**：`logger`、`typebox`（legacy TypeBox shim）、`arktype`、`zod`、`pi`（整个 SDK 导出面）。

**事件订阅 `on(event, handler)`**（穷尽）：
- 会话生命周期：`session_start`、`session_switch`、`session_branch`、`session.compacting`（可返回结果干预压缩）、`session_compact`、`session_shutdown`、`session_before_tree`（可否决）、`session_tree`、`session_stop`（可返回结果）、`before_agent_start`（可返回结果）、`agent_start`、`agent_end`
- 上下文/请求：`context`（**可改写发往 LLM 的消息**，返回 `ContextEventResult`）、`before_provider_request`、`after_provider_response`、`input`（可返回结果）
- 消息/turn：`turn_start`、`turn_end`、`message_start`、`message_update`、`message_end`
- 工具：`tool_call`（**可返回 `{block: true, reason}` 阻止执行**）、`tool_result`（可改写结果）、`tool_execution_start/update/end`、`tool_approval_requested`、`tool_approval_resolved`、`user_bash`（可返回结果）、`user_python`
- 运维：`auto_compaction_start/end`、`auto_retry_start/end`、`retry_fallback_applied/succeeded`、`ttsr_triggered`、`todo_reminder`、`goal_updated`、`credential_disabled`、`mcp_notification`、`resources_discover`（可返回结果）

**注册面**：
- `registerTool(def)` —— LLM 可调用工具（同 ToolDefinition，经扩展 wrapper 获得审批合并）；
- `registerCommand(name, {description, handler(args, ctx)})` —— 斜杠命令；
- `registerShortcut({key, handler(ctx)})` —— 键盘快捷键；
- `registerFlag(name, {type: "boolean"|"string", ...})` —— CLI flag（`getFlag(name)` 读取）；
- `registerProvider(name, config)` / `unregisterProvider(name)` —— 扩展 provider 注入 ModelRegistry（配套 `syncExtensionSources`）；
- `registerFileWriteFallback(handler)` / `registerFileDeleteFallback(handler)`；
- `registerMessageRenderer(...)`（CustomMessageEntry 渲染）、`registerAssistantThinkingRenderer(renderer)`、`registerComposerShape(definition)`；
- `sendUserMessage(content, {deliverAs?})` —— 向会话注入消息（steer/followUp/aside）；
- `exec(command, args, options?)`；
- 会话控制：`getActiveTools()/getAllTools()/setActiveTools(names)`、`setModel(model)`、`getThinkingLevel()/setThinkingLevel(level)`、`getServiceTiers()`、`getSessionName()/setSessionName(name)`、`getCommands()`；
- `events: EventBus`（自定义总线广播）、`setLabel(entryIdOrLabel, label?)`（会话切换器显示标签）、`id/name`（ExtensionContext 上另有 `ctx.ui`、`ctx.sessionManager`、`ctx.modelRegistry`、`ctx.compact()`、`ctx.runEphemeralTurn()`、受管 timer、`ctx.memory` 等，见 §4 上一版）。

### 10.3 官方扩展示例（`CA/examples/extensions/`，README 分组）

- 生命周期与安全：permission-gate（危险 bash 确认）、protected-paths（.env/.git/node_modules 写保护）、confirm-destructive、dirty-repo-guard。
- 自定义工具：hello、question（ctx.ui.select）、subagent/（隔离上下文委派）。
- 命令与 UI：plan-mode、tools（/tools 开关工具）、handoff、qna（ctx.ui.setEditorText）、status-line（ctx.ui.setStatus）、thinking-note、snake（自绘 UI + 键盘 + 持久化）。
- Git：git-checkpoint（每 turn stash checkpoint）、auto-commit-on-exit。
- 系统提示与压缩：pirate（systemPromptAppend 动态改系统提示）、custom-compaction（接管压缩）。
- 外部依赖：chalk-logger（父 node_modules 解析）、with-deps（自带 package.json）。
- hooks 示例（`examples/hooks/`，同 API 的钩子形态）：file-trigger、git-checkpoint、handoff、permission-gate、protected-paths、qna、status-line、auto-commit-on-exit、confirm-destructive、custom-compaction、dirty-repo-guard。

---

## 11. Agent 循环语义（pi-agent-core，SDK 会话直接继承）

- **消息模型**：`user/assistant/toolResult` + custom 扩展（developer/bashExecution/hookMessage/branchSummary/compactionSummary…）；`AgentToolResult {content, details, isError, providerMetadata, useless}`。
- **双队列**：steering（中断式）与 followUp（排空式），各有 `all | one-at-a-time` 模式（默认 one-at-a-time）；`interruptMode immediate|wait`；interruptible 工具 250ms 轮询。
- **aside**：后台任务完成、迟到诊断等在 step 边界非中断注入。
- **turn**：一次 assistant 响应 + 其工具调用/结果；`turn_start/turn_end` 包裹。
- **stopReason 分支**：error/aborted（占位 toolResult 保配对）、toolUse（执行）、length（占位 skipped）、pause_turn（Codex 非终态，重采样 ≤8 次）。
- **soft tool requirement**：reminder 优先、最多 3 次升级强制 toolChoice。
- **beforeToolCall/afterToolCall/transformAssistantMessage** 钩子；args 回写 assistant 消息为唯一事实源。
- **Harmony leak 防护**（GPT-5 协议泄漏：abort_retry/truncate_resume 各 ≤2）。
- **append-only context 模式**：StablePrefix + AppendOnlyLog，最大化 prefix cache。
- **abort 语义**：错误 assistant 消息落库 stopReason=aborted；tool-scoped abort 原因；外部 abort 不 drain steering 队列（留 post-abort continue）；`AgentSession.abort()` 完整序列含 abort 标题生成/autolearn/压缩/ Bash/eval。
- **投机工具执行**（`tools.speculativeExecution`，默认 off）：discard-safe 的 read 提前执行（证据 sha256，commit 前重验）。
- **in-band 方言**（`PI_DIALECT`）：glm/hermes/kimi/xml/anthropic/deepseek/harmony/qwen3/gemini/gemma/minimax；伪造 tool result 立即断流（`tools.abortOnFabricatedResult`）。

---

## 12. 上下文维护（SDK 会话自动运行；可编程干预）

- **阈值**：`thresholdTokens` > `thresholdPercent` > `window - reserveTokens`（reserve ≥ max(15% window, 16384)）；触发取 max(provider 报告占用, 本地估算)。
- **四时机**：post-turn（overflow→promotion→压缩重试；incomplete→丢死 turn 重试 ≤3）、pre-prompt（grace band 让路投机压缩）、**mid-turn**（turn_end 安全边界 splice，模型无感）、idle（idleEnabled，200k/300s）。
- **五方法**（methodOrder 可配，默认 remote→snapcompact→handoff→shake→soft）：
  1. remote：provider 原生压缩（OpenAI Responses V1/V2 streaming、Codex、Anthropic compaction beta——签名块原样回放）；
  2. snapcompact：历史序列化渲染成 PNG 帧（provider-aware 帧形状，无 LLM，确定性；foveated archive：HQ 文本边 + 图像中段）；
  3. handoff：LLM 生成交接文档（与 live turn 同管线命中 prompt cache）；
  4. shake：无 LLM 机械减重（工具结果/大代码块→占位符）；
  5. soft：本地 LLM 结构化摘要（Goal/Constraints/Progress/Decisions/Next Steps/Critical Context/Notes + 文件清单）。
- **投机压缩**：lead 带 `[threshold − clamp(12.5%, 8192, 32000), threshold)` 后台预生成。
- **轻维护**：supersedeReads（重复读剪旧，热缓存前缀保护）、dropUseless。
- **编程接入**：`session.compact(instructions, {mode?})`、`session.shake(mode)`、`auto_compaction_start/end` 事件、扩展 `session.compacting` 事件可返回结果干预、`custom-compaction` 官方示例整体接管压缩。

---

## 13. 系统提示词与上下文文件

- `buildSystemPrompt` 返回多块：主模板（Engineering/Personality/Skills & Rules/Internal URLs/Tool Inventory/Computer Use/xd:// Devices/General/Tool I/O/Specialized Tools/Exploration/AST/Delegation + 工作流）→ Computer safety → Project prompt（contextFiles + append）→ repo context。模板数据随工具/模型/项目动态变化。
- 覆盖链（SDK 选项）：`systemPrompt`（整体替换）> `systemPromptTemplate` > `customSystemPrompt` > 默认；`appendSystemPrompt` 追加；`SYSTEM.md`（project > user）文件覆盖；`PERSONALITY.md`/`titleSystemPrompt` 独立。
- 上下文文件发现：AGENTS.md walk-up（含 `.agent/`、`.agents/`）、CLAUDE.md、`@path` imports 展开、段落包含去重、depth 排序、multi-root 合并；SDK 可 `contextFiles: [...]` 整体替换或注入虚拟文件（官方示例 07）。
- 并行预取 + 5s deadline（超时步骤 fallback 后台续跑）。

---

## 14. 模型接入层要点（SDK 选型必读）

- **Provider**：82 个 catalog provider / 91 份 auth 契约 / 15 种传输 API（openai-completions、openai-responses、openai-codex-responses、azure-openai-responses、anthropic-messages、bedrock-converse-stream、google-generative-ai、google-gemini-cli、google-vertex、ollama-chat、cursor-agent、gitlab-duo-agent、devin-agent、openrouter、typesafe、apple-foundation-models）；内置目录 73 provider / 5510 模型（pricing/contextWindow/thinking/compat/tokenizer 8 族）。
- **自定义 provider**：`models.yml`（providers.models + 45 个 compat 位 + discovery 七种动态发现）或 `registry.registerProvider()` 编程注入或扩展 `registerProvider`。
- **Thinking**：6 档（minimal…max，settings 默认 high）× 5 种 wire 编码（effort/budget/google-level/anthropic-adaptive/anthropic-budget-effort）+ effortMap/effortRouting；`thinkingBudgets` 可配。
- **Prompt caching**：Anthropic ephemeral + cacheRetention(5m/1h) + keep-warm；OpenAI promptCacheKey + 显式 breakpoint + 24h；Google cachedContent；Bedrock cachePoint。SDK 侧经 `providerPromptCacheKey`/`providerSessionId` 稳定缓存身份。
- **重试层级**：provider transient（10 次/0.5s 指数/8s 上限）→ 空响应重放（2 次）→ oneshot（3 次）→ auth a/b/c（≤64 次，sibling 轮换）→ usage-aware fallback 链（`retry.fallbackChains`，角色/模型/wildcard + thinking 后缀；内置优先级表 `priority.json`）。
- **usage/cost**：Usage{input/output/cacheRead/cacheWrite/reasoningTokens/cttl/server.webSearch/credits…}；长上下文分档、时段定价、cache-write TTL 拆分、serviceTier 乘数。
- **凭据**：AuthStorage 九命名空间（§7.3）；session-sticky affinity；20 个内置 usage fetcher；401/limit 自动轮换 + scope 化退避 + 429 过期自愈。

---

## 15. 会话持久化格式（供宿主直接读取/索引）

- 每会话一个 JSONL：首行 `SessionHeader {type:"session", version 3, id, title, titleSource, timestamp, cwd, additionalDirectories?, parentSession?, previousSessionFiles?, providerPromptCacheKey?}`；256 字节标题槽可原位覆写。
- **16 种 entry**：message、model_usage、thinking_level_change、model_change、service_tier_change、compaction、branch_summary、reset_boundary、custom、custom_message、label、title_change、ttsr_injection、session_init、mode_change、credential_pin。
- 写入：同步落盘（无 fsync）、文件锁、乐观并发冲突检测、原子重写；>500k 字符截断、≥1KB 图片 base64 外置 blob store、签名块不截断。
- 目录按 canonical cwd 分桶；terminal breadcrumb 支撑 continue；officially 可选存储后端：File/Memory/Indexed/SQL/Redis（`sessionManager` 注入）。
- 宿主可只读消费：`SessionManager.open()` + `getBranch()/tree()` 或 `session/session-loader` 直接解析文件。

---

## 16. 代码智能工具（SDK 会话内可用）

- **lsp**：14 action（diagnostics/definition/references/hover/symbols/rename/rename_file/code_actions/type_definition/implementation/status/reload/capabilities/request）；内置 54 个语言 server 默认表（`lsp/defaults.json`：rust-analyzer、gopls、typescript-language-server、typescript-native、pyright、basedpyright、clangd、jdtls、kotlin-lsp、metals、hls、ocamllsp、elixirls、sourcekit-lsp、swiftlint、denols、svelte/vue/astro/tailwindcss、eslint/biome linter…）；rename 走 willRenameFiles；`formatOnWrite/diagnosticsOnWrite/Edit/diagnosticsDeduplicate`；跨会话 lsp-mux daemon 共享（`lsp.shared/lazy`）；`enableLsp/lspReadOnly` SDK 开关。
- **debug**：28 action DAP 全流程；14 个适配器默认表（gdb、lldb-dap、codelldb、debugpy、dlv、js-debug-adapter、netcoredbg、kotlin/ruby/php/bash/dart/flutter/elixir）；`dap.json` 自定义条目。
- **edit**：hashline 内容哈希锚点（`[path#TAG]`，stale 检测 + fuzzy）；五模式（replace/patch/apply_patch/hashline/sloppy；18.3.0 起用 `*** Edit File/Find/Replace` 头 + `*** Insert Before/After`）；Rust EditStore 增量预览（`tool_stream_update` 实时 diff）；auto-repair；`edit.mode`/`modelVariants` 按模型选模式。
- **ast_grep/ast_edit**：tree-sitter 结构搜索/批量改写；预览-接受（`xd://resolve|reject`，§9.5）。
- **grep/glob**：native ripgrep/glob（含 archive/sqlite/omp:// 虚拟范围）。
- **find（jfind）**：语义检索级联（judge 模型 verifier）。
- **security_scan**：原生编排（preflight/start/status/cancel/validate；repository/scoped_path/ref_diff/working_tree）+ Codex Security 云操作。
- **markit**：PDF（含 OCR 页分类）/DOCX 等文档 → Markdown（read 工具自动调用）。
- **read**：文件/目录/URI/URL/图片/PDF/SQLite/归档；行内 selector（`:N-M`/`:raw`/`:img`/`:conflicts`）；重复读 3 次循环破坏提示；投机预读。
- **bash**：持久 shell（内嵌 brush-shell + 46–58 进程内 coreutils）；`timeout/cwd/pty/async/service(name+ready)`；CRITICAL_PATTERNS 审批；bashInterceptor 专用命令重定向；自动后台。
- **eval**：持久 Python/Bun 内核；工具回调桥（`getToolForEvalBridge`）；browser/computer prelude 注入。
- **checkpoint/rewind**：git 状态标记/回退（`checkpoint.enabled`）。
- **github**：11 op（repo_view/file_read/pr_create/pr_checkout/pr_push/search_*/run_watch）+ 缓存失效联动。

---

## 17. Web / 浏览器 / 桌面 / 语音工具

- **web_search**：26 引擎（anthropic/brave/codex/duckduckgo/ecosia/exa/firecrawl/gemini/google/jina/kagi/kimi/mojeek/ollama/openrouter/parallel/perplexity/public/searxng/startpage/synthetic/tavily/tinyfish/xai/zai）+ 5 grounded provider（gemini/anthropic/codex/xai/openrouter）；web 角色链 fallback。
- **read URL**：fetch 管线（native readability→trafilatura→lynx→parallel→firecrawl→jina）；feed 解析；PDF/二进制分流。
- **90+ 专用 scraper**：github/gitlab/npm/pypi/crates-io/arxiv/pubmed/stackoverflow/hackernews/mdn/wikipedia/NVD/OSV/CISA-KEV 等。
- **browser**（eval prelude `browser` 对象，`browser.enabled` 默认 true）：CDP 架构（tab-worker/shared-daemon/browser-relay `omp browser-relay`）；导航/点击/输入/截图/aria snapshot/axe-core 无障碍审计/eval/emulation/network/console/下载/tracing/录屏；`browser.*` 配置组。
- **computer**（eval prelude，默认关）：DesktopSession（Rust）——listDisplays/listWindows/capture/click/moveMouse/drag/scroll/typeText/keyChord/raiseWindow/accessibility tree 全套（axSnapshot/axQuery/axPerform/axSetValue…）。
- **generate_image**（默认关）：image 角色链六传输；**tts**（默认关）：本地 Kokoro/xAI/openai；**stt**：sherpa-onnx 流式识别（语音输入控制会话）。
- **ssh**：`ssh://` URI 读写远程文件/远程 bash；连接池/文件传输/sshfs 挂载；`omp ssh` 管理。
- **fetch 工具注意**：reader 模式丢弃 base64 图与内联 SVG。

---

## 18. 记忆 / Advisor / Goals / auto-thinking

- **记忆 backend 五选一**（`memory.backend`：off 默认/local/hindsight/mnemopi/sharpshooter）；SDK 会话自动按 settings 装配；工具 retain/recall/reflect（hindsight+mnemopi）、memory_edit（仅 mnemopi）、learn/manage_skill（autolearn）；切换即时替换 live backend（`applyMemoryBackend()` 可编程触发）；subagent 经 `parentHindsightSessionState/parentMnemopiSessionState` 别名父状态。
- **mnemopi**（本地引擎包）：SQLite + embedding 检索（fastembed 缓存、专用 embed worker；noEmbeddings 词法退化）、autoRecall/autoRetain、巩固、polyphonic/enhanced recall。
- **hindsight**：外部服务器（retain 每 N 轮、首轮 recall、reflect 合成；全套 HINDSIGHT_* env 覆盖）。
- **advisor**：第二模型每轮旁路审查（`advisor.enabled`）；建议经 advise 工具投递；emission-guard 预算/去重、watchdog；`prepareForHeadlessAdvisorDrain()/waitForAdvisorCatchup()` 供无头收尾。
- **goals**：goal 工具 + GoalRuntime 状态机（objective + token_budget + continuation）；`goal.enabled`。
- **auto-thinking**：输入复杂度分类自动调节 thinking level（`providers.autoThinkingMaxEffort` 上限）。

---

## 19. task / subagent 体系（SDK 内自动可用）

- `task` 工具 spawn 子代理（`task.maxRecursionDepth` 默认 2 层；批量 `tasks[]`；`agent` 选择 bundled agent；`effort lo|med|hi`）。
- **隔离 worktree**：`isolated: true` → APFS/btrfs/zfs/reflink/overlayfs/projfs/block-clone/rcopy 后端快照 → 结束捕获变更应用回主工作区 → 销毁（基线 ≤1GiB；`task.isolation.apply/merge/commits`）。
- **结构化结果**：`outputSchema + schemaMode` → 子会话注册 `yield` 工具（参数按 schema 生成 + 严格校验 + 空结果重试 ≤3）；yield ladder + quiescence barrier。
- **可观测**：`subagentEventBus` 根作用域总线的 `task:subagent:*` 帧；`getSubagents` 类查询在 RPC 层暴露（SDK 侧订阅 subagentEventBus 即可拿到 lifecycle/progress/event）。
- SDK 也可**不经 task 工具**直接用 `createAgentSession` 造子会话：传 `taskDepth`、`requireYieldTool/outputSchema`、`parentAgentId`、`preloadedPreparedExtensions`（勿传 Extension 实例）。

---

## 20. MCP 支持

- 选项：`enableMCP`（默认 true）、`mcpManager`（复用实例）。
- 发现：`discoverMCPServers(cwd)` → 项目 `mcp.json/.mcp.json` + `.omp/mcp.json` + 外来格式（claude/codex/gemini/cursor/windsurf/vscode/opencode/agent-plugins）。
- **MCPManager API**（`CA/src/mcp/manager.ts`）：`discoverAndConnect(options?)`、`connectServers(...)`、`getTools(): CustomTool[]`（自动注册为 `mcp__` 前缀工具）、`waitForStartup(timeoutMs)`、`getConnectionStatus(name)`、`waitForConnection(name)`、`waitForPendingConnections()`、`addConnectionStatusListener/addCatalogChangeListener/addNotificationListener`、`setOnToolsChanged/setOnResourcesChanged/setOnPromptsChanged`、`setNotificationsEnabled`、`setAuthStorage/setAuthHandler`（MCP OAuth）、`prepareConfig(config, {oauth?})`、`getServerConfig/getSource/getConnectedServers`、`reconcileBrowserFilter`（内置 browser prelude 可用时过滤外部 browser MCP）。
- 配置：`mcp.startupTimeoutMs`、`OMP_MCP_REQUIRE_READY=1`（未就绪硬失败）、`mcp.renderMarkdownResults`、`mcp.notifications(+debounceMs)`；官方 MCP 编写指南（GitHub docs/mcp-server-tool-authoring.md）。

---

## 21. RPC 嵌入备选（同包子导出，进程内 SDK 之外的受控嵌入）

当宿主想要**子进程隔离**而非进程内驱动时：spawn `omp --mode rpc`，用导出的 `RpcClient`（`CA/src/modes/rpc/rpc-client.ts`，随包导出）驱动。

- 导出：`RpcClient`、`RpcCommandError`、`defineRpcClientTool`（自定义宿主工具：宿主进程持有执行，agent 经 `host_tool_call` 帧回调）、监听器类型（RpcEventListener/RpcSessionEventListener/RpcSubagent*Listener）。
- 协议要点：NDJSON over stdio；握手 `ready {protocolVersion, supportedProtocolVersions:[1,2], maxFrameBytes:1MiB}`；v2 分块帧（>1MiB → 256KiB rpc_chunk，重装 ≤64MiB）；命令全集 prompt/steer/follow_up/abort/set_model/compact/branch/switch_session/export_html/get_messages_page/host_tool_*/host_uri_request（宿主可注册自定义 URI scheme，如 `db://`）等（全表见官方 RPC 文档页 omp.sh/docs/rpc 与 `rpc-types.ts`）。
- 与进程内 SDK 的取舍：RPC 多一层进程隔离与协议序列化，适合崩溃隔离/多租户；进程内 SDK 延迟与控制力最佳（直接拿到 AgentSession 全 API）。

---

## 22. SDK 相关环境变量（子集；全表见官方 docs/env 与上一版 §4.3）

- 目录/配置：`PI_CODING_AGENT_DIR`、`PI_CONFIG_DIR`、`OMP_PROFILE/PI_PROFILE`、`PI_CODING_AGENT_SESSION_DIR`、`PI_CONFIG_FILES`、XDG 四件套。
- 模型：`ANTHROPIC_API_KEY/ANTHROPIC_OAUTH_TOKEN`、`OPENAI_API_KEY`、`GEMINI_API_KEY`、`XAI_API_KEY`、`AWS_*`、`GOOGLE_APPLICATION_CREDENTIALS` 等各 provider key；`PI_SMOL/SLOW/PLAN_MODEL`；`PI_DIALECT`。
- 流：`PI_STREAM_FIRST_EVENT_TIMEOUT_MS`、`PI_STREAM_IDLE_TIMEOUT_MS`。
- 工具：`PI_PY/PI_JS`、`PI_DISABLE_UUTILS_BUILTINS`、`PI_EDIT_VARIANT`、`PI_NO_PTY`、`PI_TASK_MAX_OUTPUT_*`。
- MCP：`OMP_MCP_TIMEOUT_MS`、`OMP_MCP_STARTUP_TIMEOUT_MS`、`OMP_MCP_REQUIRE_READY`。
- 网络：`PI_PROXY`、`NODE_EXTRA_CA_CERTS`、`PUPPETEER_*`。
- 行为：`PI_NO_TITLE`、`PI_NOTIFICATIONS`、`PI_TIMING`、`PI_TEST_NO_NATIVES`、`PI_DOCS_EMBED`。
- OTel：`OTEL_EXPORTER_OTLP_*`、`OTEL_SDK_DISABLED`、`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`。

---

## 23. 遥测（`telemetry: AgentTelemetryConfig`）

- `{}` 即启用 GenAI 语义约定 spans；未注册 OTEL SDK 时 no-op。
- 完整面（hooks、content capture、cost estimator、agent identity，见 `AgentTelemetryConfig`）；env `OTEL_EXPORTER_OTLP_ENDPOINT/PROTOCOL/TRACES/METRICS/LOGS` 接管导出。
- 内容捕获默认关（`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`）。

---

## 24. 安全要点（SDK 集成必须过目）

- **审批 fail-closed**：无 settings → always-ask；无 UI 无通道 → 需 prompt 的调用不可执行；显式放行：`autoApprove: true` / `tools.approvalMode` / `tools.approval.<tool>` / 扩展 `tool_call` 编程裁决。
- **secrets**（`secrets.enabled` 默认 false）：发 provider 前混淆（HMAC keyed placeholder）+ 工具执行前还原；vendor 凭据模式库（GitHub/OpenAI/AWS/Stripe/JWT/PEM…）；`isCredential()` 设置键永不出现在打印/导出。
- **模型输出不可信**：伪造 tool result 立即断流；Harmony leak 防护；leaked-thinking healing；不可信内容不进 Debug。
- **围栏**：`confineToWorkspace`、task.isolation 物理快照、skill containRoot realpath 防越界、`restrictToolNames/allowRestrictedCustomTools` 收敛工具面。
- **凭据**：`setRuntime` 不落盘；stored key/refresh token 在本机 agent.db；auth-broker 模式可集中托管。

---

## 25. 官方示例清单

`CA/examples/sdk/`（README 自带 Quick Reference）：
01-minimal（全默认）、02-custom-model（getModel/modelRegistry.getAvailable + thinkingLevel）、03-custom-prompt（替换/函数式修改系统提示）、04-skills（发现/过滤/内联 Skill）、06-hooks（行内 ExtensionFactory：日志、tool_call 阻断）、06-extensions（磁盘扩展 + additionalExtensionPaths + registerTool/registerCommand 全貌）、07-context-files（AGENTS.md 发现/虚拟注入）、08-prompt-templates、08-slash-commands、09-api-keys-and-oauth（AuthStorage.create/keys.setRuntime/ModelRegistry.create 自定义 models.json）、11-sessions（inMemory/create/continueRecent/open）、12-redis-sessions、13-sql-sessions（自定义存储后端）。（README 还列有 05-tools、10-settings、12-full-control 的说明。）

`CA/examples/extensions/` 与 `CA/examples/hooks/`：见 §10.3（permission-gate、protected-paths、plan-mode、custom-compaction、subagent、snake、with-deps 等）。

---

## 26. 关键数字速查（SDK 视角）

| 维度 | 数字 |
|---|---|
| `createAgentSession` 选项 | 60+（§3 全表） |
| AgentSession 公开方法/访问器 | ~230（§5 穷尽） |
| AgentSessionEvent 事件型 | 核心 12 + 会话级 18（§5.2 全型） |
| SessionManager 方法 | ~90（含 12 个静态构造/枚举） |
| ModelRegistry 方法 | ~40 |
| AuthStorage 命名空间 | 9（keys/oauth/sessions/usage/health/limits/resets/blocks/credentials） |
| ExtensionAPI 事件 | 40+；注册面 15+ |
| 内置工具 | 29 builtin + 3 hidden + 2 CustomTool 形态 + 2 prelude 设备 |
| MCPManager 方法 | ~20 |
| 设置键 | ~480 |
| Provider/模型目录 | 82 provider / 5510 模型 / 15 种传输 API |
| 存储 后端 | File / Memory / Indexed / SQL / Redis |
| SDK 示例 | 14（官方 examples/sdk） |
| Bun 最低 | 1.3.14；npm 最新 18.4.3 |

---

*报告完。数据截止 2026-09-30；源码锚点 @oh-my-pi/pi-coding-agent 18.3.0。所有 API 以源码签名为准；升级到 18.4.x 请复核 §3 选项表与 CHANGELOG Breaking Changes 节。*
