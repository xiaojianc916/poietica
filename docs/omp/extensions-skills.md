# omp 扩展体系（extensions / plugins / hooks / custom tools & commands / skills）

> 来源：`CA/src/extensibility/`（extensions/types.ts 1216 行起为 ExtensionAPI 契约）、`CA/src/capability/`、`CA/src/discovery/`、`CA/src/skillshare/`、官方 examples/extensions + examples/hooks（18.3.0）。

## 1. Extensions（TypeScript 模块）

**能力总览**（types.ts 头注）："Extensions are TypeScript modules that can: Subscribe to agent lifecycle events; Register LLM-callable tools; Register commands, keyboard shortcuts, and CLI flags; Interact with the user via UI primitives."（注：旧名 "hooks"，API 中已统一为 extensions——官方示例 06-hooks.ts 明示。）

### 1.1 形态与装载
- **行内**：`createAgentSession({extensions: [(pi: ExtensionAPI) => {...}]})`（与发现合并）。
- **文件**：默认导出 `(pi: ExtensionAPI) => void` 的 TS 模块；加载用原生 Bun import（支持外部依赖 jiti 模块解析——chalk-logger/with-deps 官方示例）。
- **发现路径**：`~/.omp/agent/extensions/`、`<cwd>/.omp/extensions/`、settings `extensions[]` 数组、`--extension/-e` flag（可重复）、`additionalExtensionPaths`（SDK 合并项）。
- **受信扩展**：`--trusted-extension <abs>` 精确路径加载、禁兄弟目录隐式发现、禁与 `-e/--hook` 同用（CliUsageError）。
- **禁用**：`--no-extensions`（显式 -e 仍加载；CLI 注入根变为 explicit-only）。
- 每个 `Extension` 实例**绑定其会话的 ExtensionAPI**（cwd、eventBus、runtime）——不可跨会话复用；subagent 转发用 `preloadedPreparedExtensions`（重绑到子会话 API，受限子代理保留 hooks/providers 但不暴露扩展工具）。
- 生命周期：装配完成后发 `session_start`（`modes/runtime-init.ts`）；runtime 动作面：sendMessage/sendUserMessage/appendEntry/setLabel/tools/model/thinking/serviceTier/sessionName + context 动作（getModel/isIdle/abort/shutdown/getContextUsage/runEphemeralTurn/compact）+ 命令动作（newSession/branch/navigateTree/switchSession/reload）。

### 1.2 ExtensionAPI 全成员（`extensions/types.ts:1216`）

**注入**：`logger`（文件 logger）、`typebox`（legacy TypeBox shim）、`arktype`（omptype schema builder）、`zod`（omptype zod 兼容）、`pi`（整个 pi-coding-agent SDK 导出面）。

**事件订阅 `on(event, handler)`（穷尽）**：
- 会话生命周期：`resources_discover`（可返回结果）、`session_start`、`session_switch`、`session_branch`、`session.compacting`（可返回 SessionCompactingResult 干预）、`session_compact`、`session_shutdown`、`session_before_tree`（可否决）、`session_tree`、`session_stop`（可返回结果）、`before_agent_start`（可返回 BeforeAgentStartEventResult）、`agent_start`、`agent_end`
- 上下文/请求：`context`（**可改写发往 LLM 的消息**，返回 ContextEventResult）、`before_provider_request`（BeforeProviderRequestEvent）、`after_provider_response`、`input`（可返回 InputEventResult）
- 消息/turn：`turn_start`、`turn_end`、`message_start`、`message_update`、`message_end`
- 工具：`tool_call`（可返回 `{block: true, reason}` 阻止执行）、`tool_result`（可改写结果；分 Bash/Read/Edit/Write/Grep/Glob/Custom 变体）、`tool_execution_start/update/end`、`tool_approval_requested`、`tool_approval_resolved`、`user_bash`（可返回结果）、`user_python`
- 运维：`auto_compaction_start/end`、`auto_retry_start/end`、`retry_fallback_applied/succeeded`、`ttsr_triggered`、`todo_reminder`、`goal_updated`、`credential_disabled`、`mcp_notification`、`before_subagent_spawn`（BeforeSubagentSpawnEvent）

**注册面**：
- `registerTool(def)` —— LLM 可调用工具（经 ExtensionToolWrapper 获得审批合并；schema 用注入的 arktype/typebox/zod）；
- `registerCommand(name, {description, handler(args, ctx)})` —— 斜杠命令；
- `registerShortcut({key, handler(ctx)})` —— 键盘快捷键；
- `registerFlag(name, {type: "boolean"|"string", ...})` —— CLI flag（`getFlag(name)` 读取；可 shadow 同名内建）；
- `registerProvider(name, config)` / `unregisterProvider(name)` —— provider 注入 ModelRegistry（配套 `syncExtensionSources`）；
- `registerFileWriteFallback(handler)` / `registerFileDeleteFallback(handler)`；
- `registerMessageRenderer(...)`（CustomMessageEntry 渲染）、`registerAssistantThinkingRenderer(renderer)`（渲染在原 thinking 文本后）、`registerComposerShape(definition)`；
- `sendUserMessage(content, {deliverAs?: steer|followUp|aside})`；
- `exec(command, args, options?)`；
- 会话控制：`getActiveTools()/getAllTools(): ToolInfo[]/setActiveTools(names)`、`setModel(model)`、`getThinkingLevel()/setThinkingLevel(level)`、`getServiceTiers()`、`getSessionName()/setSessionName(name)`、`getCommands(): SlashCommandInfo[]`；
- `events: EventBus`（自定义总线）、`setLabel(entryIdOrLabel, label?)`（会话切换器显示标签）、`id`/`name`。

**ExtensionContext**（handler 的 ctx）：`ui`（ExtensionUIContext）、`mode(tui|rpc|json|print)`、`getContextUsage()`、`getAsyncJobSnapshot()`、`compact(instructionsOrOptions?)`、`hasUI`、`cwd`、`sessionManager`（Readonly）、`modelRegistry`、`localProtocolOptions?`、`model`、`models`（ExtensionModelQuery）、`isIdle()`、`abort()`、`hasPendingMessages()`、`shutdown()`、`isProjectTrusted()`、`getSystemPrompt(): string[]`、`runEphemeralTurn(options)`（/btw 式侧 turn，不入会话史）、`memory`（MemoryRuntimeContext）、受管 `setInterval/setTimeout/clearTimer`（dispose 清理）、`invokeTool?`。

**ExtensionUIContext**：`select(title, options, dialogOptions?)`、`confirm(title, message, opts?)`、`input(title, placeholder?, opts?)`、`askDialog?(questions, opts?)`（富提问对话框）、`notify(message, type?: info|warning|error)`、`onTerminalInput(handler)`（返回退订）、`setStatus(key, text)`、`setWorkingMessage(message?)`、`setWidget(key, content, {placement: aboveEditor|belowEditor})`、`setFooter/setHeader(factory)`、`setTitle(title)`、`custom<T>(factory, opts?)`（自绘组件接管键盘，factory(tui, theme, keybindings, done)）、`setEditorText(text)`、paste 注入、`open_url`（RPC 下走短链防截断）；`timeoutStartsOnPresentation?`。

### 1.3 官方扩展示例（`CA/examples/extensions/`）
- 生命周期与安全：permission-gate（危险 bash 确认）、protected-paths（.env/.git/node_modules 写保护）、confirm-destructive（clear/switch/branch 确认）、dirty-repo-guard（未提交改动防会话变更）。
- 自定义工具：hello（最小）、question（ctx.ui.select）、subagent/（隔离上下文委派）。
- 命令与 UI：plan-mode（Claude Code 式只读 plan）、tools（/tools 开关工具 + 会话持久化）、handoff（/handoff <goal> 转移上下文）、qna（提取问题到编辑器）、status-line（setStatus + 主题色）、thinking-note（thinking 块补充 UI）、snake（自绘 UI + 键盘 + 持久化）。
- Git：git-checkpoint（每 turn stash checkpoint）、auto-commit-on-exit。
- 系统提示与压缩：pirate（systemPromptAppend 动态改系统提示）、custom-compaction（整体接管压缩）。
- 外部依赖：chalk-logger（父 node_modules）、with-deps（自带 package.json）、file-trigger（watch 触发文件注入会话）。

## 2. Hooks（`extensibility/hooks/`）

- **HookEvent 联合**（hooks/types.ts）：`SessionEvent` 全家族、`ContextEvent`（可改写消息）、`BeforeAgentStartEvent`、`AgentStart/End`、`TurnStart/End`、`AutoCompactionStart/End`、`AutoRetryStart/End`、`TtsrTriggered`、`TodoReminder`、`ToolCallEvent`（可 block/替换 args）、`ToolResultEvent`（Bash/Read/Edit/Write/Grep/Glob/Custom，可改写）。
- **HookAPI**（`pi` 对象）：注册命令、UI（同 HookUIContext/ExtensionUIContext）、exec、事件订阅、读会话 entries（官方文档示例：过滤 `custom` entry 实现 permission 记账）。
- `HookFactory = (pi: HookAPI) => void`；`HookHandler<E, R>`；`HookError`；`RegisteredCommand`。
- 装载：`--hook <file>`；`.omp/hooks/`、用户级 hooks 目录；Claude hooks 格式经 discovery（claude provider hooks/ 映射）。
- 官方示例 `examples/hooks/`：auto-commit-on-exit、confirm-destructive、custom-compaction、dirty-repo-guard、file-trigger、git-checkpoint、handoff、permission-gate、protected-paths、qna、status-line。

## 3. Plugins 与 marketplace（`extensibility/plugins/`）

- **manifest**：package.json 的 `omp`（或 `pi`）字段：
  - `PluginManifest {name?, version, description?, tools?, hooks?, extensions?[], commands?[], features?, settings?}`（入口路径相对包根）；
  - `PluginFeature {description?, default?, extensions?[], tools?[], hooks?[], commands?[]}`（选择性安装）；
  - `settings?: Record<string, PluginSettingSchema>`——string/number/boolean/enum，`secret?`（UI/日志遮蔽）、`env?`（fallback env 变量）、default?。
- 安装：`omp install <targets>`（本地路径 → link；npm spec / `name@marketplace` → install；`--scope user|project`、`--dry-run`、`--force`）；`~/.omp/plugins/`（node_modules + `omp-plugins.lock.json`）；git 缓存（bun-git-cache）。
- `omp plugin` 全动作：install/uninstall/list/link/doctor/features/config/enable/disable/marketplace/discover/upgrade；feature flags `--enable/--disable/--set key=value`。
- marketplace 子系统：registry/fetcher/cache/source-resolver/manager；`~/.omp/marketplaces.json` 注册表；`marketplace.autoUpdate` 自动升级。
- legacy pi 兼容：legacy-pi-compat.ts + 虚拟模块声明（legacy-pi-virtual-modules.d.ts）。

## 4. Custom tools（`extensibility/custom-tools/`）

- **CustomToolAPI**（稳定跨会话）：`cwd`、`exec(command, args, options?)`、`ui`（CustomToolUIContext）、`hasUI`（print/RPC/无头为 false）、`logger`、`typebox`（legacy）、`arktype`、`zod`、`pi`（SDK 导出面）、`pushPendingAction(action)`。
- **CustomToolPendingAction**：`{label, apply(reason), reject?(reason), details?, sourceToolName?}`——由隐藏 resolve 工具消费的预览-接受流（ast_edit 同款）。
- **CustomToolContext**（execute/onSession 传入）：`sessionManager`（只读）、模型信息等。
- ToolDefinition：`{name, label?, summary?, description, parameters, execute(toolCallId, params, onUpdate, ctx, signal), approval?, loadMode?, concurrency?, deferrable?, strict?, intent?}`；`customToolToDefinition` 转换。
- 发现：`.omp/tools/`、`.claude/tools/`、插件等；`customTools` 传入即替换发现；`allowRestrictedCustomTools` 控制受限会话（仍须列入 toolNames）。
- 状态持久化模式（官方 README）：工具结果 `details` 进会话条目；分支/重放时经 `session_start` 从 `ctx.sessionManager.getBranch()` 重建（树导航安全）。

## 5. Custom commands（`extensibility/custom-commands/`）

- **文件型**：markdown + frontmatter；`SlashCommand {name, path, content, level: user|project|native, description?, argumentHint?}`（frontmatter `argumentHint`/`argument-hint`）；位置：`.omp/commands/`（项目）、`~/.omp/agent/commands/`（用户）+ Claude/opencode 来源开关（`commands.enableClaudeUser/Project`、`commands.enableOpencodeUser/Project`）。
- **TS 型**：`CustomCommand` 模块导出 factory（注入 CustomCommandAPI：arktype、zod、execCommand、PiCodingAgent 命名空间；Bun 原生 import）。
- **Bundled 三个**：
  - `/review`（bundled/review/）：P0–P3 分级 code review + verdict；diff 目标解析（PR/本地/分支）、大 diff 限流（`LARGE_DIFF_CHARACTER_LIMIT=50_000`、`LARGE_DIFF_FILE_LIMIT=20`）、多 reviewer agent（getRecommendedReviewAgentCount）、annotations.md 模板；
  - `/annotate`（bundled/annotate/）：向 diff、回复、会话消息、文件或引用文本附加注释；fullscreen overlay、text-review/text-summary 模式；注释可插入或发送进 prompt 与 review；
  - `/ci-green`（bundled/ci-green/）：驱动到 CI 绿——HEAD tag 检测、branch/pushRemote 解析（branch.*.pushRemote/remote config）、ci-green-request.md 模板。

## 6. Skills（`capability/skill.ts` + `discovery/builtin.ts` + `extensibility/skills.ts`）

- **格式**：SKILL.md markdown + frontmatter——`name?`、`description?`、`globs?[]`、`alwaysApply?`、`hide?`、`disableModelInvocation?`（agentskills.io 规范 kebab-case 归一化，等同 hide）+ 任意扩展字段。
- **发现位置**：项目 `.omp/skills/`（walk-up 祖先，最近优先）、用户 `~/.omp/agent/skills/`、`~/.omp/agent/managed-skills/`（autolearn 专用，MANAGED_SKILLS_PROVIDER_ID，最低优先）、`.claude/skills/`（project 默认开、user 默认关）、`.codex/skills/`（user 默认关）、`.agents/skills/`（开）、`skills.customDirectories[]`；开关全表见 config-auth-secrets.md §2；过滤 `skills.ignoredSkills[]`（glob）、`includeSkills[]`（glob，空=全部）、`--skills <globs>`。
- **运行时模型**（extensibility/skills.ts）：`Skill {name, description, filePath, baseDir, source, hide?, containRoot?, _source?}`；进程全局快照 `getActiveSkills()`（skill:// 协议读取用）；autoload 模板（`prompts/skills/autoload.md`）与 user-invocation 模板。
- **注入**：system prompt `<skills>` 清单（name+description；hide/disabled 除外）；全文经 `skill://<name>` 惰性读取；`/skill:<name>` 斜杠调用（`modes/skill-command.ts`：parseSkillInvocation → buildSkillPromptMessage → promptCustomMessage，optimistic 渲染、steer/followUp 队列行为）；token 预算（`allowsSkillTokens`/SKILL_TOKEN_RE）。
- **manage_skill 工具**：agent create/update/delete **managed skills**（不能覆盖同名 authored skill——被遮蔽时返回 isError）。
- **skillshare**（`skillshare/` client/installer/manifest/pack/tar + `omp skill` 命令）：官方 registry（skills.omp.sh，`skills.registryUrl`）；动作 publish/version/tag/yank/deprecate/owner/token(create|ls|revoke)/import/install/update/uninstall/search/info；flags `-g/--global`、`-y/--yes`、`--json`、`--sort relevance|downloads|recent`、`--scope`、`--tag`、`--dry-run`、`--allow-secrets`、`--registry`、`--undo`、`--package`、`--expires <days>`。

## 7. Capability 系统架构（`CA/src/capability/`）

18 个 capability 类型：context-file、extension-module、extension、fs、hook、instruction、mcp、prompt、rule-buckets、rule、settings、skill、slash-command、ssh、system-prompt、tool 等。
- 机制：capability provider 按 priority 插入排序 → 同 key 高优先 shadow 低优先（禁用行保留为 shadow 记录）→ 语义等价去重（first wins）→ `loadCapability` 聚合；`isUserSourceEnabled` 控制用户级外来源 opt-in。
- discovery 侧 provider 把外部文件映射成 capability 条目（全表见 config-auth-secrets.md §5）；`discovery/builtin.ts` 注册内置 provider（omp/agents/managed-skills/builtin-rules 等）。
- **builtin rules**（`discovery/builtin-rules/`）：28 条 TTSR/规则 markdown（go 8：add-cleanup、bench-loop、exp-promoted、ioutil、join-hostport、new-expr、rand-v2、range-int；rs 6：box-leak、future-prelude、lazylock、match-ergonomics、parking-lot、result-type；ts 14：bare-catch、import-type、no-any、no-deprecated-leftovers、no-dynamic-import、no-inline-cast-access、no-local-is-record、no-return-type、no-test-timers、no-tiny-functions、promise-with-resolvers、redundant-clear-guard、set-map 等）。

## 8. registry（`CA/src/registry/`）

`agent-registry.ts`（AgentRegistry 全局/共享 agent 身份注册）、`agent-lifecycle.ts`（AgentLifecycleManager：park/live、TTL park、JSONL 复活）、`persisted-agents.ts`（持久化 parked 子代理扫描）。
