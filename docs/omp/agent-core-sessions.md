# omp Agent 循环、会话与上下文维护

> 来源：`PAC/src`（pi-agent-core）、`CA/src/session/`、`CA/src/system-prompt.ts`、`SC/src`（snapcompact）、`CA/src/compress/`（18.3.0）。

## 1. Agent 核心循环（pi-agent-core）

### 1.1 消息与状态
- `AgentMessage = user | assistant | toolResult`（provider refusal 剔除；`CustomAgentMessages` declaration merging 扩展：developer、bashExecution、hookMessage、branchSummary、compactionSummary 等）。
- `AgentToolResult`：`content`（text/image 块）、`details`、`isError`、`providerMetadata`、`useless`（"上下文无用"标记，供压缩剪除）。
- `AgentState`：systemPrompt[]（多块）、model、thinkingLevel、disableReasoning、tools、messages、isStreaming、streamMessage、pendingToolCalls、error。

### 1.2 双队列与中断语义
- `#steeringQueue` 与 `#followUpQueue`；`steer(m)` 入队并唤醒 steering waiter；`followUp(m)` 入队。
- **steeringMode**：`all | one-at-a-time`（默认 one-at-a-time）；followUpMode 同构；构造参数 + 运行期 `setSteeringMode/setFollowUpMode/setInterruptMode(persist)`。
- **interruptMode**：`immediate | wait`（默认 immediate）——immediate 截断可中断等待并对运行中工具抛协作式 steeringSignal；wait 等工具跑完；interruptible 工具运行期间每 250ms 轮询（`STEERING_INTERRUPT_POLL_MS`）。
- 队列所有权/恢复：`prepareQueuedMessages`（排他 claim + commit/restore）、abort 时 `#restoreUndeliveredQueuedMessages` 塞回队首、`popLastSteer/popLastFollowUp`（LIFO 取回供 TUI 撤回）、peek 非消耗视图。
- `hasSteeringMessages` 返回 `SteeringQueueState {queued, source: user|agent|system|unknown}`（attribution 区分真人 vs agent/system）。
- **aside（非中断消息）**：后台任务完成、迟到 LSP 诊断等在 step 边界注入，绝不打断在跑工具；thunk 延迟决策 + `ASIDE_MESSAGE_COMMIT/DISCARD` 提交协议；`hasIrcInterrupts`、`hasBackgroundCompletions` 可打断等待。
- magic keywords notice、图片描述 companion 作为 hidden custom 消息伴随 prompt 入队（`CA/session/queued-messages.ts`）；队列 chip UI；`popLastQueuedMessage` 恢复到编辑器。
- idle 时自动 `agent.continue()` 排空队列（empty-transcript 分支防 OOM spin，issue #6344）。

### 1.3 循环结构（`PAC/agent-loop.ts`）
- 外层 `while(true)`：agent 本应停止时 drain follow-up；内层处理工具调用与 steering。
- 每 iteration：`yieldIfDue()` → 进程级 `agentPauseGate`（`/pause` 冻结所有 loop）→ 注入 pending（steering+aside）→ `syncContextBeforeModelCall` → `getToolChoice` 指令 → `prepareProviderCall` → `beforeModelCall` gate（可 `{stop:true}` 拒发）→ `turn_start` → `streamAssistantResponse` → 按 stopReason 分支。
- **turn 语义**：一个 turn = 一次 assistant 响应 + 其工具调用/结果；`turn_start/turn_end` 包裹；`onTurnEnd` 钩子。
- **stopReason 分支**：`error/aborted` → 每个 toolCall 生成占位 toolResult（保持配对）；`toolUse` → `executeToolCalls`；`length` → toolCall 配 "skipped/length" 占位；`stop + stopDetails.type==="pause_turn"`（Codex 非终态）→ 重采样继续，上限 `MAX_PAUSED_TURN_CONTINUATIONS=8`。
- **soft tool requirement**：`SoftToolRequirement {soft, id, toolName, satisfies?, reminder}`——host 想要某工具先被调用但不付 `tool_choice` 强制的 cache 失效代价：先注入 reminder，不服从才升级 forced toolChoice（上限 `MAX_SOFT_TOOL_ESCALATIONS=3`）；旁路调用替换为 skipped 结果。
- 工具批执行：`ToolCallContext {batchId, index, total, toolCalls, steeringSignal}`；`AgentTool.concurrency: "shared"|"exclusive"|fn`；`interruptible` 声明；`beforeToolCall`（可 block/替换 args，args 回写 assistant 消息为唯一事实源）、`afterToolCall`（字段级覆盖 content/details/providerMetadata/isError/useless）、`transformAssistantMessage`（宏展开）。
- **Harmony leak 防护**：GPT-5 Harmony 协议泄漏检测；两种恢复 `abort_retry`（≤2）与 `truncate_resume`（≤2），升级后抛错。
- **follow-up 边界**：停止前 `onBeforeYield` → 再 poll 一次 steering → asides + followUps 作为 pendingMessages continue；否则 `agent_end`。
- **append-only context 模式**（`PAC/append-only-context.ts`）：StablePrefix（system prompt + tool spec 字节冻结，`invalidate()` 才变）+ AppendOnlyLog（消息只增不改）——最大化 provider prefix cache（DeepSeek/Anthropic）；`sentToolDefinitions` 填充 `Context.inactiveTools`。
- 动态 per-call 解析：`getModel/getReasoning/getDisableReasoning/getServiceTier/getCwd` 支持 mid-run 切模型/thinking/tier/cwd。
- in-band tool calling 方言（`resolveOwnedDialectFromEnv`，env `PI_DIALECT`）：glm/hermes/kimi/xml/anthropic/deepseek/harmony/qwen3/gemini/gemma/minimax；模型伪造 tool result 时 `abortOnFabricatedToolResult` 默认立即断流。

### 1.4 abort/cancel 语义
- `Agent.abort(reason)` → AbortController；错误 assistant 消息 `stopReason:"aborted"` 落库；未配对 toolCall 生成 aborted 占位结果；`abortReasonText`、`createToolScopedAbortReason`（只标匹配 toolCall，兄弟给中性消息）、`TERMINAL_TOOL_RESULT_ABORT_REASON`（hook 标记终态，如 subagent yield）、`TOOL_INTERRUPT_ABORT_REASON`（steering/IRC/background 打断 interruptible 工具，与用户 abort 区分）；外部 abort 时 steering 队列刻意不 drain（留 post-abort continue）。
- CA 侧 `AgentSession.abort()` 序列：user interrupt 标记（`USER_INTERRUPT_LABEL`，抑制 advisor 自动恢复）→ abort 标题/autolearn/usage preflight/retry → abort handoff → abort 自动压缩（或 preserveCompaction）→ abortBash/abortEval → `agent.abort()` → 等 idle → 重录被搁置 advisor 卡片 → `#drainStrandedQueuedMessages()`。

### 1.5 投机工具执行（speculative execution）
- 配置：`tools.speculativeExecution.enabled`（默认 false，实验）、`maxInFlight`（2）。
- 候选调用在正式 dispatch 前提前执行但对模型不可见，直到普通 dispatch 认领；效果必须 discard-safe（`pure` 或 `local_read`）。
- 生命周期：`assess → captureEvidence → execute → validate → commit | discard`；流式工具可投影依赖感知子操作（`SpeculativeChildDefinition/Handle`）。
- CA 宿主（`CA/speculation/host.ts`）：只允许 `read` 的 local_read；approval 全 allow、无扩展 lifecycle handlers、非二进制/PDF/SQLite/视频/SVG/ipynb/可转换文档；证据 = dev+ino+mtime+size+sha256；commit 前重验（symlink 重解析、字节级 digest、类型门）；telemetry：committed/discarded/ineligible/fingerprint_mismatch/aborted/commit_conflict。

### 1.6 Prewalk
plan todo 建立后的**首个 edit/write 处**单向切到快模型（`prewalk.enabled` 或 `--prewalk`；目标 `--prewalk-into` 默认 smol 角色）——规划用慢模型、执行用快模型。

## 2. 会话持久化

### 2.1 目录布局
- 会话根 `~/.omp/agent/sessions`，按 canonical cwd 分桶：home 相对 `--`→`-` 前缀（如 `-Users-x-code-myrepo`）、tmp 相对 `-tmp-…`、其余 legacy 绝对路径编码 `--D--xiaojianc-…--`；含三代命名（legacy 绝对 → 17.2.5-17.2.8 hashed → 现行相对）的一次性迁移（`session-paths.ts`）。
- **terminal breadcrumb**：`~/.omp/agent/terminal-sessions/<ttyId>` 记录 `cwd\nsessionFile\n[fresh]\ncwdstat <dev> <ino>`——支撑 `--continue`"本终端上次会话"；`fresh` 标记懒创建（JSONL 未落盘）；dev+ino 识别项目改名/移动。
- 内容寻址 blob 库 `~/.omp/agent/blobs`；`history.db`；`custom-session-files/`。
- 多根工作区：`SessionHeader.additionalDirectories`（每个额外 root 各自发现 context files）。

### 2.2 文件格式（JSONL）
- 每会话一个 `.jsonl`：首行 `SessionHeader {type:"session", version 3, id, title, titleSource, timestamp, cwd, additionalDirectories?, parentSession?, previousSessionFiles?, providerPromptCacheKey?}`。
- **256 字节固定宽度标题槽**（`SESSION_TITLE_SLOT_BYTES`）：原位覆写标题不重写文件，配 `title_change` 审计条目。
- 写入（`session-storage.ts` + `session-manager.ts`）：`append/appendSync` 同步落盘（无 fsync——崩溃最多丢最后一页）、文件锁 `SessionLockError`、乐观并发 `SessionWriteConflictError`、原子整文件重写（`writeTextAtomic` + commitGuard）、`#expectedDiskSize` 追踪、`flushSync/seal`；后端 file/memory/indexed/sql/redis + draft sidecar。
- 持久化清洗（`session-persistence.ts`）：>500k 字符截断（`MAX_PERSIST_CHARS`）；≥1KB 图片 base64 外置 blob store（`BLOB_EXTERNALIZE_THRESHOLD`；content 块/images[]/snapcompact frames[] 三处）；签名块（thinkingSignature/textSignature/thoughtSignature/redactedThinking/encrypted_content、Anthropic server-tool 与 anthropicCompaction 载体）原子保存不截断；OpenAI Responses reasoning item 双存去重。

### 2.3 SessionEntry 全类型（16 种，`session-entries.ts`）
1. `message`；2. `model_usage`（非对话类调用计量：purpose/role/api/provider/model/usage/stopReason）；3. `thinking_level_change`；4. `model_change`（"provider/modelId" + role + fallback 标记）；5. `service_tier_change`；6. `compaction`（summary/shortSummary/firstKeptEntryId/tokensBefore/tokensAfter/method/providerReplayThroughEntryId/details/preserveData/fromExtension/warning）；7. `branch_summary`（离开分支的摘要）；8. `reset_boundary`（/clear 持久边界）；9. `custom`（扩展状态，不进 LLM）；10. `custom_message`（扩展注入且**参与** LLM 上下文）；11. `label`（条目标签）；12. `title_change`；13. `ttsr_injection`；14. `session_init`（subagent 初始上下文，供 replay）；15. `mode_change`（plan mode 等）；16. `credential_pin`（OAuth 账号 pin sha-256，resume 复用 account-scoped prompt cache）。

### 2.4 树 / 分支 / 导航
- 每条 entry 有 `id/parentId` 成树；`SessionEntryIndex` 维护 leaf、`childrenOf`、`pathTo(leaf)`、`tree()`（SessionTreeNode + label）、labelsInEffect。
- `branch(branchFromId)` 把 leaf 移到历史节点（追加即新分支）；`branchWithSummary` 先追加 branch_summary 再分叉；`getUserMessagesForBranching` 供 UI 列可分叉点。
- `navigateTree(targetId, {summarize, customInstructions, allowAskReopen, reanswerAskResult})`：离开分支可生成 branch summary（`PAC/compaction/branch-summarization.ts`），ask toolResult 两阶段 re-answer；`branchFromBtw`（/btw 侧问分支）。
- `cloneCurrentSession`、`captureState/restoreState`。

### 2.5 resume / continue / fork / import
- CLI：`--continue/-c`（breadcrumb + 最近回退）、`--resume [id]`（选择器）、`--fork`、`--from-claude/--from-codex`（`foreign-session-store.ts`、`claude/codex-session-store.ts` 导入为 omp 格式）。
- Agent 侧 `Agent.continue()`：空 transcript、尾部未配对 toolCall（`unpairedToolCallTail` 先重执行再消费队列）、queued steering/followUp 作为开场 turn；turn 崩溃恢复 `CA/session/turn-recovery.ts`（unexpected-stop 分类、重试/回退）+ `turn-persistence.ts`。
- provider 层 resume 状态：`providerSessionId`、`providerPromptCacheKey`（fork 继承）、`credential_pin`。

### 2.6 Handoff（交接文档）
`session-handoff.ts`：oneshot LLM 生成 handoff 文档——走与 live turn 相同管线（同 system prompt、normalize tools、obfuscation、`buildSideRequestContext`）命中 provider prompt cache；`compaction.handoffSaveToDisk` 时写 `artifacts/handoff-<ISO>.md`；文档作为 compaction entry 提交（引擎侧 `PAC/compaction/compaction.ts` generateHandoff + `prompts/handoff-document.md`）。

## 3. 上下文压缩

### 3.1 阈值与触发
- 阈值（`PAC/compaction/compaction.ts`）：`thresholdTokens>0` clamp [1, window-1]；否则 `thresholdPercent∈[1,99]`；否则 `window - reserveTokens`（reserve ≥ max(15% window, 16384)，默认 16384）。触发上下文取 max(provider 报告占用, 本地估算)。摘要预算 `min(0.8*reserve, MAX_SUMMARY_TOKENS=16384)`。
- **四时机**（`session-maintenance.ts`）：
  - post-turn：overflow 证据（ContextOverflow/payload-rejection/HTTP 413/usage-backed）→ 先 context promotion（换大窗口模型不压缩重试）→ 否则压缩重试；incomplete（length 空转）→ 丢死 turn、压缩重试 ≤3；
  - pre-prompt：超阈值 → grace band 让路 speculative → promotion → `runAutoCompaction("threshold", …, autoContinue:false)`；
  - **mid-turn**（`compaction.midTurnEnabled` 默认 true）：turn_end 安全边界同步持久化后压缩，messages 原地 splice 回活动数组，模型无感；模型可显式 `new_context` 请求 rollover；
  - idle：`compaction.idleEnabled`，超 `idleThresholdTokens`(200000) 空闲 `idleTimeoutSeconds`(300) 触发。
- `autoContinue`（true）：压缩后自动继续原任务。
- 每轮轻维护：`supersedeReads`（同文件重复读剪旧读，prompt-cache guard——热缓存前缀内不剪）、`dropUseless`（useless 结果消费后剪除；skill/artifact 结果受 `tool-protection.ts` 保护）。

### 3.2 methodOrder：五种方法（默认 `["remote","snapcompact","handoff","shake","soft"]`，失败顺延）
1. **remote**（server compaction）：OpenAI Responses compact（V1 + V2 streaming）、OpenAI Codex compaction、Anthropic compaction beta（`compact-2026-09-04`，只送 prefix，签名块原样回放，保留 thinking 必须同模型）；成功后本地不做冗余摘要，durable 历史存 `preserveData`；不可复用时 `prepareCompaction` 重新展开原始消息。
2. **snapcompact**（见 §4）。
3. **handoff**：生成 handoff 文档作 compaction summary（reason≠"overflow" 时可用；threshold 触发可 defer 为 post-prompt task）。
4. **shake**（`PAC/compaction/shake.ts`）：无 LLM 机械减重——工具结果文本与大 fenced/XML 块 → 短占位符；`DEFAULT_SHAKE_CONFIG {protectTokens:16000, minSavings:4000, protectedTools:[skill, skillRead, artifactRecovery], fenceMinTokens:400}`；`/shake` 手动用 AGGRESSIVE config（无 savings 阈值、跨全历史）；只动 compaction boundary 之后。
5. **soft**：本地 LLM 摘要——`serializeConversationForSummary` → 多窗口 `planSummaryWindows`（输入预算 200k，下限 16384）→ SUMMARIZATION_PROMPT（Goal / Constraints & Preferences / Progress(Done/In Progress/Blocked) / Key Decisions / Next Steps / Critical Context / Additional Notes）→ split-turn 并行 turn 前缀摘要 + PR 式短摘要 → `<files>` 读写文件清单（`upsertFileOperations`）。

### 3.3 异步 / 投机压缩
- `compaction.asyncEnabled`（true）：接近阈值时后台 speculative summarizer 先算摘要，跨阈值 splice；lead 带 `[threshold − clamp(threshold*12.5%, 8192, 32000), threshold)`（`session/speculation-lead.ts`）；status line context gauge 画 marker；remote/handoff/soft 可投机，snapcompact/shake 本地即时无需。
- **Remote Compaction V2**（`compaction-v2-streaming.ts`）：镜像 Codex `compact_remote_v2.rs`——向正常 Responses 流追加 `{type:"compaction_trigger"}` input item，要求恰好一个 streamed compaction output，以"retained real user messages + compaction item"替换历史；`V2_RETAINED_MESSAGE_TOKEN_BUDGET=64000`、重试 2、超时 300s、`IMAGE_TOKEN_ESTIMATE=765`；endpoint 覆盖 OpenAI Responses/Azure/Codex；失败回退 V1 → 本地摘要。

## 4. Snapcompact（`SC/snapcompact.ts`，独立包）

**原理**：把被丢弃历史的序列化文本用像素字体渲染成稠密 PNG 帧，vision 模型直接读图；全程本地确定性、**无 LLM 调用**；光栅化在 Rust（`pi-natives` `renderSnapcompactPng`）。
- 序列化：`¶user:` / `¶think:` / `¶ai:` / `¶call:` 分节；tool call 带 `//intent` 注释；结果并入 `<out>` 块；截断预算 `TOOL_RESULT_MAX_CHARS=2000`/`TOOL_ARG_MAX_CHARS=500`/`TOOL_CALL_MAX_CHARS=2000`、head 60% tail 40%；`useless` 结果跳过；`dimToolResults`；`includeThinking`（对 Claude 关闭防 reasoning_extraction 误判，#6093）；data URL 原子 elide（防截断产生永不解码的坏图）。
- 归一化：ANSI 剥离、空白折叠（换行→█）、NFKD ASCII 折叠、box-drawing→ASCII、emoji 折叠表；CJK 用内嵌 Silver TrueType `silver16-bw` 网格（CJK-heavy：≥8 宽字符且 ≥25%）；`scanRenderability` >5% `?` 换 Silver。
- **帧形状 provider-aware**（eval 验证 f1）：Anthropic `11on16-bw`（8x13 字形 11px advance，f1 .806；Opus 4.7+/Fable/Mythos 用 1932px 高清帧，patch cap 4784）；Google `8on22-bw` @2048（Gemini 3.x 固定 1120 token/图，f1 .934）；OpenAI `8on22-bw` @1568（area-proportional patch 计价）；未知默认 `8on22-bw`；17 种 SHAPE_VARIANTS（含 doc-* 双栏报纸布局）。
- 预算：`MAX_FRAMES_DEFAULT=80`（≈40 万 token 高清帧，低于 ~100 图 wire cap）、`FRAME_DATA_BYTES_BUDGET=3MB`、`PROVIDER_IMAGE_BUDGETS`（anthropic 90/openai 200/google 200/openrouter 90/umans 10/unknown 5）。
- **foveated archive**：HQ 文本边（head/tail 各 1 页 verbatim）+ 图像中段；中段超预算内部 foveate（HQ 边 3 帧 + 低质密集中段 + 丢最老）；帧持久化 `CompactionEntry.preserveData["snapcompact"]`（frames/text/textHead/textTail/totalChars/truncatedChars）；重建上下文时重新附着（textHead → imaged middle → textTail）；重压缩展开旧 archive 源文本连贯重渲染（旧 provider payload 剥离；`blob:sha256:` 惰性解析）。
- 摘要消息：`snapcompact-summary.md` 模板；`shortSummary = "Archived N chars onto F frames (+X chars as text)"`。
- **inline imaging**（`CA/session/snapcompact-inline.ts`）：与压缩无关的 per-request 变换——把 system prompt / context-file 指令 / 大工具结果换成 PNG 帧（瞬态不落盘）；swap 策略 `planInlineSwaps` 与 /context 估算共享；省 token 记入 savings journal。

## 5. TTSR（Time-Traveling Stream Rules，`CA/export/ttsr.ts` + `session/ttsr-coordinator.ts`）

- **定义**："流式输出中途命中条件即注入"的规则；命中时**中止当前流、把规则作为 system reminder 注入、重试请求**。"Time-traveling"指：默认 `contextMode: "discard"` 把上下文**回卷到违规 assistant 消息之前**（`replaceMessages(messages.slice(0, targetAssistantIndex))`），丢弃已生成的违规内容再带着规则重新生成。
- 规则结构（`capability/rule.ts`）：`conditions: RegExp[]`、`astConditions`（ast-grep 模式，对 edit/write 整文件快照在 toolcall_end 跑 native astMatch）、`question`（judged 规则，绝不流中匹配）、scope（`allowText/allowThinking/allowAnyTool/toolScopes[{toolName, pathGlob}]`）。内置规则 `CA/discovery/builtin-rules/`（go 8 条、rs 6 条、ts 14 条，如 ts-no-any、rs-box-leak、go-new-expr）。
- 流匹配：`text_delta`（text）、`thinking_delta`（thinking）、`toolcall_delta/end`（经工具 `matcherDigest/matcherPaths/matcherEntries` 钩子重建"真实内容"摘要，支持 per-file glob 如 `tool:edit(*.ts)`；无钩子工具退回原始参数 delta）；缓冲按 streamKey 隔离。
- 触发效果：interruptMode（always 默认/prose-only/tool-only/never）→ `agent.abort(createToolScopedAbortReason("TTSR matched rules: …"))` → 50ms 后 post-prompt task：discard 回卷 → 注入 `ttsr-injection` hidden custom 消息（持久化 custom_message + ttsr_injection entry）→ `agent.continue()`；`resumeGate` promise 供恢复路径等待；非打断命中 → followUp 或折叠进工具 result（`ttsr-tool-reminder.md`）。
- judged 规则（`ttsr.judge: auto|on|off`）：对完成输出由 judge 模型答 question，一次请求批量问（jev 状态共享），`JUDGED_RULE_THRESHOLD=0.7`、`JUDGED_CONTENT_MAX_TOKENS=32000`；命中以 `ttsr-warning.md` 非中断警告交付。
- repeat gating：`ttsr.repeatMode: "once"|"after-gap"`、`repeatGap: 10`；同 stream key 同规则去重（只发一次 `ttsr_triggered`）。
- 配置组：`ttsr.contextMode/builtinRules/disabledRules`；测试命令 `omp ttsr test|list|scan`。

## 6. /compact 手动与 omp compress（防混淆）

- `/compact soft`（本地摘要跳过 server）、`/compact remote`（server 优先回退本地）、`/compact snapcompact`（无 LLM，不接受 focus 文本）；其余参数为 focus instructions；模式是对 `compaction.*` 的一次性 override。`/clear` 写 `reset_boundary`。
- **omp compress**（`CA/compress/`，无关命令）：把文本文件重写进 "dense prompt register"——每文件独立会话、仅 `rewrite`（提交草稿+声明 losses）与 `approve` 两工具；审批 gate 防 agent 自证；默认 3 轮、4 并发；未批准不落盘。

## 7. 系统提示词（`CA/system-prompt.ts`）

### 7.1 结构（返回多块）
1. **Block 0 主模板**（Handlebars，`prompts/system/system-prompt.md`）：`# Engineering`、`# Personality`、`# Skills & Rules`、`# Internal URLs`、`# Tool Inventory`（native+非 inline 时紧凑名单；否则完整 Harmony `namespace functions` 目录）、`# Computer Use`、`# xd:// Tool Devices`、`# General`、`# Tool I/O`、`# Specialized Tools`、`# Exploration`、`# AST`、`# Delegation`(+gates)、工作流（1. Scope → 2. Research Before Editing → 3. Decompose → 4. Implement → 5. Verify → 6. Cleanup）。模板数据随项目/工具/模型动态变化（OS/Arch、cwd、additionalWorkspaceRoots、model、delegationBias、personality、intentTracing、eagerTasks、taskBatch/MAX_CONCURRENCY、scoutAvailable、taskIrcEnabled、secretsEnabled、hasMemoryRoot、securityEnabled、browserEnabled、computerEnabled、hasObsidian、renderMermaid、reactions、xdevTools/xdevDocs、autoQaEnabled、writeTransportOnly 等）。
2. Computer safety block（computerEnabled 时）。
3. Project prompt（contextFiles + appendPrompt）。
4. Active repo context block。
- 覆盖：`SYSTEM.md`（project > user；支持 template 变体）、`--append-system-prompt`/`APPEND_SYSTEM.md`（USER_APPEND_HEADING 权威边界）、`PERSONALITY.md`（内置 default/friendly/pragmatic；`personality:"none"` 省略）、`TITLE_SYSTEM.md`、`NULL_PROMPT=1` 全空。
- 并行预取 + **5s deadline**（`SYSTEM_PROMPT_PRET_TIMEOUT_MS`；超时步骤 fallback 后台续跑）。

### 7.2 上下文文件发现
- capability API（`capability/context-file.ts`）：AGENTS.md 项目 walk-up（含 `.agent/`、`.agents/` 目录内）+ 用户 home；standalone CLAUDE.md walk-up；`.claude/CLAUDE.md`；`~/.codex/AGENTS.md`；`~/.config/opencode/AGENTS.md` 等。
- 处理：`@path` imports 展开（相对文件自身目录）；`dedupeContainedContextFiles` 段落包含去重（深层/远端文件被更近文件完整包含则省略）；depth 降序（离 cwd 近者最后、更突出）；multi-root 逐 root 发现合并；workspace tree 的 AGENTS.md 索引有 `AGENTS_MD_LIMIT` 上限。

## 8. 事件系统

### 8.1 核心 AgentEvent（`PAC/types.ts`）
`agent_start`；`agent_end {messages, telemetry?, coverage?}`；`turn_start`；`turn_end {message, toolResults}`；`message_start {message}`；`message_update {message, assistantMessageEvent}`（携带底层 text_delta/thinking_delta/toolcall_* 事件）；`message_end`；`tool_execution_start {toolCallId, toolName, args, intent?}`；`tool_execution_update {…, partialResult}`；`tool_stream_update {toolCallId, toolName, update}`；`tool_execution_end {…, result, isError?}`。

### 8.2 会话级 AgentSessionEvent（`session/agent-session-events.ts`）
继承核心（agent_end 扩展 `isTerminal?`）；`auto_compaction_start/end`；`auto_retry_start/end`；`retry_fallback_applied/succeeded`；`model_changed`；`config_warnings_changed`；`advisor_cost_changed`；`advisor_yielded`；`thinking_level_changed {thinkingLevel, configured?, resolved?}`；`goal_updated`；`ttsr_triggered {rules}`；`todo_reminder {todos, attempt, maxAttempts}`；`todo_auto_clear`；`irc_message`；`notice {level, message, source?}`。运行态另有 `subscribeRunState("running"|"idle")`。

### 8.3 附：CA/src/stream/ 是直播/录制子系统（非 LLM 流式）
本地协议（Unix socket/named pipe NDJSON：hello/resize/history/viewport/patch/reset/paused）、streamer 多路复用、paint-encoder 行归一化+脱敏、redactor、`.ompcast` 录制（JSONL：header + `[ms, frame]`）、player 回放、clip-upload、多 pane 观看 TUI。
