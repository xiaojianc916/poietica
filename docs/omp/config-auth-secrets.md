# omp 配置系统、鉴权与 secrets

> 来源：`PU/src/dirs.ts`、`CA/src/config/`（settings-schema.ts 6390 行为单一 schema 事实源，约 480 键）、`CA/src/config.ts`、`CA/src/discovery/`、`CA/src/secrets/`（18.3.0）。

## 1. 磁盘布局（`PU/src/dirs.ts`，DirResolver 集中管理）

**根规则**
- 配置根：`~/.omp`（`CONFIG_DIR_NAME=".omp"`；`PI_CONFIG_DIR` env 覆盖目录名）。
- agent 目录：默认 `~/.omp/agent`；`PI_CODING_AGENT_DIR` 整体重定向（仅默认 profile 生效）。
- **profile**：`OMP_PROFILE`（canonical）/ `PI_PROFILE`（legacy）激活命名 profile → `~/.omp/profiles/<name>/agent`；名字须 `^[a-z0-9][a-z0-9._-]{0,63}$`，禁 Windows 保留名（CON/PRN/AUX/NUL/COM0-9/LPT0-9）。
- **XDG（Linux/macOS）**：`$XDG_{DATA,STATE,CACHE}_HOME/omp` 目录存在时迁移（`agent/` 前缀展平，如 `~/.omp/agent/sessions` → `$XDG_DATA_HOME/omp/sessions`）；需先 `omp config init-xdg` 迁移。
- env 文件加载顺序（`PU/src/env.ts`）：`~/.env` → `~/.omp/.env` → `~/.omp/agent/.env` → 项目 `cwd/.env`、`.env.<NODE_ENV>`、`.env.local`、`.env.<NODE_ENV>.local`；`.env` 里的目录变量（XDG_*_HOME、PI_CODING_AGENT_DIR）加载后触发 `refreshDirsFromEnv()` 重建解析器。

**`~/.omp/` 根下**

| 路径 | 用途 |
|---|---|
| `config.yml` / `config.yaml` | 全局主配置（canonical 写 config.yml；legacy `settings.json` 首启迁移为 YAML+`.bak`） |
| `install-id` | 安装 UUID（telemetry/grievance 去重；跨 profile 共享，O_EXCL 创建） |
| `marketplaces.json` | plugin marketplace 注册表 |
| `agent/` | agent 数据目录（见下） |
| `profiles/<name>/agent/` | 命名 profile |
| `reports/`、`logs/omp.YYYY-MM-DD.PID.log` | 报告与日志 |
| `plugins/`（node_modules、package.json、`omp-plugins.lock.json`） | npm 安装的插件 |
| `remote/`、`remote-host/` | remote mount / SSH host 信息 |
| `wt/` | agent 管理 worktree（`OMP_WORKTREE_DIR` 或 `worktree.base` 覆盖；子目录为路径 7 位 hex hash） |
| `ssh-control/` | SSH control socket |
| `python-env/` | 托管 Python venv |
| `puppeteer/` | puppeteer 沙箱 |
| `browser-relay/`、`browser-profiles/` | 浏览器 relay 扩展 / Chromium profile |
| `webcache/` | docs.rs 缓存 |
| `autoqa.db` | auto-QA grievances SQLite |
| `cache/`（github-cache.db、commit-inference.db、legacy-pi-extension-cache.db、auth-broker-snapshot.enc、avatars/、fastembed/） | 各类缓存（`OMP_GITHUB_CACHE_DB` 等可隔离） |
| `natives/` | 原生二进制 |
| `stats.db` | 使用统计 SQLite |
| `autoresearch/`（`<project>/`、`<project>.db`、`runs/<runId>`） | autoresearch 状态 |
| `security/` | 安全分析状态 |
| `run/tiny/`、`run/daemons/<hash>/`、`run/daemons/global/<service>/`、`run/provider-inflight/` | tiny worker socket / 每项目与全局 daemon runtime / 跨进程 provider 并发限流 |

**`~/.omp/agent/` 下**

| 路径 | 用途 |
|---|---|
| `config.yml`（`.yaml` 兼容） | 全局主配置 |
| `models.yml`（`models.yaml` 兼容；legacy `models.json` 迁移） | 自定义 provider/model |
| `agent.db` | SQLite：settings 迁移源 + auth storage（OAuth token/API key 凭据库） |
| `history.db`、`models.db` | 会话历史 / 模型缓存 |
| `sessions/`、`blobs/`（内容寻址）、`terminal-sessions/`、`custom-session-files/` | 会话与二进制数据 |
| `themes/`、`tools/`、`commands/`、`prompts/`、`modules/`、`skills/`、`managed-skills/`、`memories/` | 用户级自定义 |
| `cache/tiny-models/`、`cache/document-conversions/`、`cache/composer/` | 缓存 |
| `secret-placeholder.key` | secrets 系统 per-install HMAC key（0600；XDG 下移 `$XDG_STATE_HOME/omp/`） |
| `last-changelog-version` | changelog 已读 marker |
| `omp-crash.log`、`omp-debug.log` | 崩溃/调试日志 |
| `python-gateway/` | Python gateway 状态 |
| `AGENTS.md`、`RULES.md`、`SYSTEM.md`、`PERSONALITY.md`、`TITLE_SYSTEM.md`、`plans/` | 用户级上下文文件 |

**项目级 `.omp/`（cwd）**：`config.yml`、`settings.json`、`mcp.json`、`ssh.json`、`secrets.yml`、`modules/`、`prompts/`、`skills/`、`extensions/`、`agents/`、`AGENTS.md`、`RULES.md`、`plugin-overrides.json`。

## 2. config.yml 全部配置键（分组穷尽；默认值已核实）

**General/Auth/Startup**：`setupVersion`(0)、`auth.broker.url`、`auth.broker.token`(credential)、`auth.accountPolicies`、`autoResume`(false)、`power.sleepPrevention`(off/idle/display/system="idle")、`shellPath`、`git.enabled`(true)、`extensions[]`、`enabledModels[]`、`enabledProviders[]`、`disabledProviders[]`（支持 path-scoped 条目）、`disabledExtensions[]`、`startup.quiet/showSplash/setupWizard/checkUpdate/changelogMode(summary|expanded|hidden)`、`update.channel`、`marketplace.autoUpdate`。

**Advisor/Prewalk**：`advisor.enabled`(false)、`advisor.syncBacklog`(off/1/3/5="off")、`advisor.immuneTurns`(3)、`advisor.maxNotesPerUpdate`(4=ADVISOR_DEFAULT_BUDGET_PER_UPDATE)、`prewalk.enabled`(false)。

**Model 角色与选择**：`modelRoleStorage`(global/project="global")、`modelRoles`（role→"provider/model" 或 ["@smol","@slow"] 角色链）、`modelTags`（name/color/hidden）、`modelProviderOrder[]`、`cycleOrder`(["smol","default","slow"])、`enabledModels`。

**Appearance/TUI**：`theme.dark`("titanium")、`theme.light`("light")、`symbolPreset`(unicode/nerd/ascii)、`colorBlindMode`、`composer.shape`("band")、`composer.tokenRate`、`statusLine.preset(default/minimal/compact/full/nerd/ascii/custom)`、`statusLine.separator`(7 种,"powerline-thin")、`statusLine.contextLine(off/percentage/annotated/embedded)`、`statusLine.sessionAccent(true)/transparent/compactThinkingLevel(true)/showHookStatus/leftSegments/rightSegments/segmentOptions`、`terminal.showImages(true)/showProgress`、`tui.maxInlineImageColumns(50)/maxInlineImageRows(20)/maxInlineImages(8)/resizeScrollback/textSizing/renderMermaid(true)/reactions/codexResetFireworks/titleState/titleSpinner/hyperlinks/mouse/tight/vimMode/vimModeDisplay/imeSafeCursor`、`display.shimmer/pinnedAgents/smoothStreaming/hideToolActivity/showTokenUsage/showTurnTime/cacheMissMarker/collapseCompacted`、`showHardwareCursor`。

**Images/blob**：`images.autoResize/blockImages/describeForTextModels/questionTimeoutMs`、`images.urls.enabled`、`urls.backends(["provider-files","tailscale","cloudflared","litterbox"])`、`urls.options/credentials/command/publicBaseUrl/ttlHours(72)/bindHost("127.0.0.1")/sshTarget/sshRemotePort(8787)`。

**Thinking/loop guards**：`defaultThinkingLevel`(minimal/low/medium/high/xhigh/max/auto，**"high"**)、`hideThinkingBlock`(false)、`proseOnlyThinking`(true)、`omitThinking`(false)、`externalThinking`(false)、`model.loopGuard.enabled(true)/checkAssistantContent(true)/toolCallReminder(true)`、`model.toolCallLoopGuard.enabled(true)/threshold(5)/exemptTools(["wait"])`、`thinkingBudgets.minimal/low/medium/high/xhigh/max`(1024/2048/8192/16384/32768/32768)。

**Prompt/sampling**：`inlineToolDescriptors(auto/on/off)`、`includeModelInPrompt(true)`、`includeWorkspaceTree(false)`、`skillful`、`personality(default/friendly/pragmatic/none)`、`temperature/topP/topK/minP/presencePenalty/repetitionPenalty`(-1=provider 默认)、`textVerbosity(medium)`、`extendedContext(false)`。

**Service tier**：`tier.openai/anthropic/google/subagent/advisor`（openai-only/claude-only 等 scoped sentinel；旧 `serviceTier` 键自动迁移）。

**Retry/fallback**：`retry.enabled(true)`、`maxRetries(10)`、`baseDelayMs(500)`、`maxDelayMs(300000)`、`waitForUsageReset(false)`、`modelFallback`、`usageAwareFallback`、`usageReservePct(10)`、`usageReservePolicy`、**`fallbackChains`**（record：role/`provider/model`/`provider/*`/`id前缀*` → 有序 fallback selector 数组，支持 `:low/:high/:max/:off` thinking 后缀）、`fallbackRevertPolicy`、`providers.anthropic.serverSideFallback`。默认链来自 `CA/src/priority.json`（smol/slow/image/web/speech/dictation/judge 角色候选顺序）。

**交互/输入**：`steeringMode`（旧 queueMode 迁移）、`followUpMode`、`interruptMode`、`loop.mode`、`loop.conditionTimeoutMs(30000)`、`composer.recallClearedDrafts`、`doubleEscapeAction(rewind/tree/none)`、`treeFilterMode`、`autocompleteMaxVisible`、`spelling.typoDetection/autocomplete/autocorrect`、`emojiAutocomplete`、`paste.largeMenuThreshold`、`completion.notify`、`error.notify`、`ask.timeout(240s)/notify`、`recap.enabled/idleSeconds`。

**Collab/share/stream/skills 仓库**：`collab.relayUrl/webUrl/displayName/autoStart`、`share.serverUrl/store(true)/redactSecrets(true)`、`stream.serverUrl/redactPatterns[]`、`skills.registryUrl`。

**STT/TTS/speech/tiny**：`stt.enabled/language("en")/submitTrigger`、`tts.localVoice`、`live.voice`、`speech.enabled/mode/enhanced/voice`、`providers.tinyModelDevice/Dtype`。

**Compaction/上下文**：`contextPromotion.enabled`、`compaction.enabled(true)`、`experimentalContextManagement`、`midTurnEnabled(true)`、`methodOrder`、`thresholdPercent(-1)`、`thresholdTokens(-1)`、`handoffSaveToDisk(false)`、`remoteStreamingV2Enabled(true)`、`asyncEnabled(true)`、`reserveTokens`、`keepRecentTokens(20000)`、`autoContinue(true)`、`remoteEndpoint`、`v2RetainedMessageBudget(64000)`、`idleEnabled`、`idleThresholdTokens(200000)`、`idleTimeoutSeconds(300)`、`supersedeReads(true)`、`dropUseless(true)`、`branchSummary.enabled/reserveTokens(16384)`、`snapcompact.systemPrompt/toolResults/shape`。

**Memory**：`memory.backend`(**off**/local/hindsight/mnemopi/sharpshooter)；`memories.*`：enabled、maxRolloutsPerStartup(64)、maxRolloutAgeDays(30)、minRolloutIdleHours(12)、threadScanLimit(300)、maxRawMemoriesForGlobal(200)、stage1Concurrency(8)、stage1LeaseSeconds(120)、stage1RetryDelaySeconds(120)、phase2LeaseSeconds(180)、phase2RetryDelaySeconds(180)、phase2HeartbeatSeconds(30)、rolloutPayloadPercent(0.7)、phase1InputTokenLimit(4000)、fallbackTokenLimit(16000)、summaryInjectionTokenLimit(5000)；`hindsight.*`：apiUrl/apiToken(credential)/bankId/bankIdPrefix/scoping/bankMission/retainMission/autoRecall/autoRetain/retainMode/retainEveryNTurns(3)/retainOverlapTurns(2)/retainContext("omp")/recallBudget/recallMaxTokens(1024)/recallContextTurns(1)/recallMaxQueryChars(800)/recallTypes(["world","experience"])/debug/requestTimeoutMs(30s)/reflectTimeoutMs(120s)/recallTimeoutMs(30s)/retainTimeoutMs(60s)/mentalModelsEnabled/mentalModelAutoSeed/mentalModelMaxRenderChars(16000)；`mnemopi.*`：dbPath/bank/scoping/embeddingVariant/autoRecall/autoRetain/polyphonicRecall/enhancedRecall/proactiveLinking/noEmbeddings/embeddingModel/ApiUrl/ApiKey/llmMode/BaseUrl/ApiKey/Model/retainEveryNTurns(4)/recallLimit(8)/recallContextTurns(3)/recallMaxQueryChars(4000)/injectionTokenLimit(5000)/debug；`sharpshooter.*`：model/intervalMinutes(5)/injectionTokenLimit(15000)。

**Tools**：`tools.format`、`tools.approval(record)`、`tools.approvalMode`、`artifactSpillThreshold(50KB)/artifactTailBytes/artifactHeadBytes/outputMaxColumns/artifactTailLines`、`intentTracing`、`abortOnFabricatedResult`、`speculativeExecution.enabled(false)/maxInFlight(2)`、`maxTimeout`、`xdev(true)/xdevDocs/xdevInlineDevices`、`readLineNumbers`、`read.defaultLimit/renderMarkdown/summarize.enabled/prose/minBodyLines/minCommentLines/minTotalLines/unfoldUntil/unfoldLimit/toolResultPreview`。

**Edit**：`edit.mode`、`fuzzyMatch`、`fuzzyThreshold`、`streamingAbort`、`recoverInlineEdits`、`blockAutoGenerated`、`enforceSeenLines`、`blackbox.enabled`、`autoRepair.enabled`、`modelVariants`（model 名 pattern → patch/replace/hashline/apply_patch）。

**LSP**：`lsp.enabled/lazy/shared/formatOnWrite/diagnosticsOnWrite/diagnosticsOnEdit/diagnosticsDeduplicate`。

**Bash/exec/eval**：`bash.enabled/allowCompoundCommands/autoBackground.enabled+thresholdMs+strategy(catalog)/patterns/direnv/direnvLoadTimeoutMs`、`bashInterceptor.enabled+patterns`（默认 10 条）、`shellMinimizer.enabled/settingsPath/only/except/maxCaptureBytes/sourceOutlineLevel/legacyFilters`、`eval.py/js/autoProvision/tools.enabled/workpool.freshAgents/autoBackground.enabled+thresholdMs`、`python.kernelMode/interpreter`、`async.enabled/maxJobs`。

**工具开关**：`todo.enabled/reminders/remindersMax/eager`、`glob.enabled`、`grep.enabled/contextBefore/contextAfter`、`astGrep.enabled(false)`、`astEdit.enabled(true)`、`find.enabled(auto)`、`debug.enabled(true)`、`launch.enabled(true)`、`speechgen.enabled(false)`、`generate_image.enabled(false)`、`computer.enabled(false)/display/maxWidth/maxHeight`、`checkpoint.enabled(false)`、`fetch.enabled(true)`、`vault.enabled`、`github.enabled(false)`、`github.cache.enabled/softTtlSec/hardTtlSec`、`web_search.enabled(true)`、`security.enabled(false)`、`ask.enabled(true)`、`browser.enabled(true)/cdpUrl/relay/relayUrl/headless/cmux/freezeOnTurnEnd/idleCloseSec/screenshotDir`。

**MCP/plan/goal/task**：`mcp.enableProjectConfig/startupTimeoutMs/renderMarkdownResults/notifications/notificationDebounceMs`、`plan.enabled/defaultOnStartup/autosave/autosaveDir`、`goal.enabled(true)/statusInFooter/continuationModes`、`title.refreshOnReplan`、`task.isolation.enabled(false)/backend(auto/apfs/btrfs/zfs/reflink/overlayfs/projfs/block-clone/rcopy)/apply(true)/merge/commits`、`worktree.clone(true)/cleanSource(false)/base`、`task.eager/batch/enableEffort/maxConcurrency/enableLsp/maxRecursionDepth(2)/maxRuntimeMs/agentIdleTtlMs(420s)/softRequestBudget(+Notice)/maxEffort/disabledAgents[]/agentModelOverrides/agentServiceTierOverrides/agentPrewalk/agentAdvisor/prewalk/showResolvedModelBadge`、`tasks.todoClearDelay`。

**Skills/commands 多源开关**：`skills.enabled(true)/enableSkillCommands/enableCodexUser(false)/enableClaudeUser(false)/enableClaudeProject(true)/enablePiUser(true)/enablePiProject(true)/enableAgentsUser(true)/enableAgentsProject(true)/customDirectories[]/ignoredSkills[]/includeSkills[]`、`commands.enableClaudeUser/Project`、`commands.enableOpencodeUser/Project`。

**Secrets/隐私**：`secrets.enabled`（**默认 false**；"Obfuscate configured secrets and redact credential-shaped tokens before sending to AI providers"）。

**Providers 服务项**：`providers.maxInFlightRequests(record)`、`openai-codex.codeMode(off/on/auto)+codeModeDirectTools[]`、`ollama-cloud.maxConcurrency(3)`、`webSearchTimeoutSeconds`、`antigravityEndpoint`、`fireworksTier`、`autoThinkingMaxEffort`、`kimiApiFormat`、`openaiWebsockets`、`cacheRetention`、`streamFirstEventTimeoutSeconds`、`streamIdleTimeoutSeconds`、`openrouterVariant`、`fetch`。

**搜索/重置/杂项**：`exa.enabled+searchDelayMs`、`searxng.endpoint/token/basicUsername/basicPassword/categories/engines/language/safesearch`、`codexResets.autoRedeem/minBlockedMinutes/keepCredits/salvageHorizonHours`、`claudeResets.*`（同构四键）、`provider.appendOnlyContext`（本地 llama.cpp 系 append-only KV-cache 模式）、`extensionHandlers.toolCallTimeoutMs`、`dev.autoqa/autoqaPush.endpoint/token/autoqaConsent`、`gc.blobs(true)/archive(true)/wal(true)/coldArchiveAfterDays(30)/retainNewestGlobal(20)/retainNewestPerCwd(10)`、`magicKeywords.enabled+<id>`、`features.unexpectedStopDetection(none/mechanical/smart)`、`inline-tool-descriptors-mode`。

`isCredential()` 标记的键（schema 顶层 `credential: true` 或 `ui.secret`，如 `auth.broker.token`、`hindsight.apiToken`、`mnemopi.embeddingApiKey`）永不被打印/导出。

## 3. 配置层级与覆盖顺序（`CA/src/config/settings.ts`）

低 → 高：
1. **schema defaults**（settings-schema.ts）
2. **global**：`~/.omp/agent/config.yml`（legacy `settings.json` + agent.db 内 settings 一次性迁移）
3. **project**：capability discovery 聚合 deep-merge（`.omp/config.yml`、`.omp/settings.json`、`.claude/settings.json` 等多源；`.omp/config.yml` 的 `modelRoles` 单独叠加）
4. **config overlay**：CLI `--config <file>`（可多份；`PI_CONFIG_FILES` env 用 path.delimiter 分隔）；缺失/格式错是硬错误
5. **runtime overrides**：`settings.override()`（CLI flags、SDK 注入，不持久化）

角色 provenance：`runtime → overlay → project → global → default`。project 层用 `dropSettingsGroupShadows` 丢弃会覆盖整组设置的非对象值（防 `.claude/settings.json` 的外来 `"tui": "fullscreen"` 摧毁整个 tui 组）。多配置目录优先级：`.omp`（global） > `.claude` > `.codex` > `.gemini`；user 层 > project 层；monorepo 场景 `findAllNearestProjectConfigDirs` 向上逐级找最近配置目录。

保存：`settings.set()` 同步内存 + debounce 写回 config.yml；按 path 粒度记录 modified；保存前比对 YAML generation（mtime/ctime/inode/size）防并发 clobber；`modelRoles` 支持 role 粒度持久化；损坏 YAML quarantine 到 `.bak` 重建。

## 4. 热重载

- config.yml：无文件 watcher。进程内 `settings.set()/override()` 即时生效（SETTING_HOOKS 副作用：主题/symbol preset/shell 等）；`onEffectiveChange` 监听器 + modelRoles/statusLine/Code-Mode signal。外部修改在两种时机重读：(a) 每次结构化 subagent/task 派发前 `settings.reloadFromDisk()`（`task/structured-subagent.ts` 原子三路重读 global+project+overlay 后重放全部 hooks）；(b) `reloadForCwd/cloneForCwd` 在 `/move`、跨项目 resume 时。
- **models.yml：真正 mtime 热重载**（见 models-providers.md §8）。
- **memory.backend**：切换即时替换 live backend/tools/listeners/system-prompt。
- 主题文件：TUI watcher。插件：`/reload-plugins`；MCP：`/mcp reload`。

## 5. 外来配置原生读取/继承（capability provider 系统，`CA/src/discovery/`）

机制：每 provider 有 priority（越大越优先），同名条目高优先者胜；**用户级（~/）外来目录默认关闭（opt-in，经 `/providers` UI 或 `enabledProviders` 设置）**；项目级始终读取。`FOREIGN_USER_PROVIDERS = { cursor, codex, claude, claude-plugins, gemini, opencode, windsurf, github }`；`.omp` 与 `.agents` 默认开启。JSON 中 `${VAR}` 经 `expandEnvVarsDeep` 展开。

| Provider（priority） | 读取 | 映射为 |
|---|---|---|
| **claude**（80） | `~/.claude/`（或 `$CLAUDE_CONFIG_DIR`）与项目 `.claude/`：settings.json；commands/、agents/、skills/、rules/、hooks/、.mcp.json/mcp 配置、extensions/、system prompt 文件、CLAUDE.md；另读 `.claude.json` | settings / slash-commands / skills / rules / hooks / MCP servers / extension modules / context-files / system-prompt / custom tools |
| **claude-plugins**（70） | `~/.claude/plugins/cache/` + installed_plugins.json | skills / MCP / rules / slash-commands / hooks / custom tools（`${CLAUDE_PLUGIN_ROOT}` 替换） |
| **codex** | `~/.codex/` 与 `.codex/`：AGENTS.md（用户级）、config.toml（TOML→settings）、prompts/、skills/、mcpServers、hooks、extensions/ | context-files / settings / prompts / skills / MCP / hooks / extension modules / slash-commands / system-prompt / tools |
| **gemini**（60） | `~/.gemini/` 与 `.gemini/`：settings.json（mcpServers）、GEMINI.md、system.md、extensions/*/gemini-extension.json | MCP / context-files / system-prompt / extensions / settings |
| **opencode**（55） | `~/.config/opencode/` 与 `.opencode/`、opencode.json(c)：AGENTS.md（用户级）、"mcp" 键、skills/、commands/、plugins/ | context-files / MCP / settings / skills / slash-commands / extension-modules |
| **cursor**（50） | `~/.cursor/` 与 `.cursor/`：mcp.json（mcpServers）、rules/*.mdc（MDC frontmatter: description/globs/alwaysApply）、settings.json | MCP / rules / settings |
| **windsurf**（50） | `~/.codeium/windsurf/` 与 `.windsurf/`：mcp_config.json、rules/*.md、global_rules.md、legacy `.windsurfrules` | MCP / rules |
| **cline**（40） | 项目 `.clinerules`（文件或目录，向上查找） | rules |
| **vscode**（20） | `.vscode/mcp.json`（嵌套 mcp.servers） | MCP |
| **agents-md** / **claude-md**（10） | 项目树向上独立 AGENTS.md / CLAUDE.md | context-files |
| **mcp-json**（5） | 项目根 mcp.json/.mcp.json（Claude Desktop 格式，含 enabled/timeout/requestIdFormat） | MCP |
| **agent-plugins** | agent-plugins.org 1.0.0 插件根（plugin.json）：skills/（SKILL.md）+ 根 mcp.json | skills / MCP |
| **github** | GitHub 工具配置（FOREIGN user provider 之一） | — |

## 6. 鉴权（OAuth / login / API key 存储）

- **OAuth provider 注册表**：91 份 auth KDL（详见 models-providers.md §6）；`/login` 名单顺序 `_order.kdl`。
- **登录入口**：会话内 `/login [provider|redirect URL]`（无参→OAuth provider 选择器；进行中可粘贴 redirect URL 完成手工回调——`modes/oauth-manual-input.ts` 单 pending promise 管理）；`/logout [provider]` 对称。终端 `omp login [provider]`（readline picker → 浏览器 OAuth → 完成后 `modelRegistry.refreshProvider(storeCredentialsAs, "online")`）。
- **认证目标**：本地 `agent.db` credential store 或远程 **auth-broker**（`auth.broker.url/token` 设置或 `OMP_AUTH_BROKER_URL/TOKEN` env，env 优先；`omp auth-broker serve`）；另有 `omp auth-gateway`（provider `transport: "pi-native"`）。
- **API key 级联**：`runtime (--api-key) → config (models.yml apiKey) → OAuth token → login key → env var → stored key (agent.db)`。models.yml `apiKey` 三形态：`!command …`（shell 取 stdout，缓存+30s 失败退避）、env 变量名（live 读取）、字面量。
- **多账号**：agent.db 每 provider 多条 credential row；session-sticky affinity + usage-aware ranking + 401/usage-limit 时 `limits.rotate()` 换 sibling（详见 models-providers.md §7）。
- **key 落盘事实**：OAuth refresh token 与 stored key 存 agent.db（SQLite，本机）；models.yml 明文 key 是用户显式选择；runtime `--api-key` 仅内存。

## 7. secrets 系统（`CA/src/secrets/`，`secrets.enabled` 默认 false）

- **secrets.yml**（全局 `~/.omp/agent/secrets.yml` + 项目 `.omp/secrets.yml`，project 条目按内容覆盖 global）：YAML 数组，条目 `{type: "plain"|"regex", content, mode: "obfuscate"|"replace", replacement?, flags?, friendlyName?}`（`loadSecrets`）。
- **env secrets 自动收集**：变量名匹配 `/(KEY|SECRET|TOKEN|PASSWORD|PASS|AUTH|CREDENTIAL|PRIVATE|OAUTH)(_|\$)/i` 且值 ≥8 字符；第二轮从 `scheme://user:pass@host` URL 提取密码。
- **内置 vendor 凭据模式**（`patterns.ts` CREDENTIAL_PATTERNS/CREDENTIAL_PREFIX_RULES）：GitHub（ghp_/gho_/github_pat_）、GitLab glpat-、Anthropic sk-ant-、OpenAI sk-proj-/sk-、AWS AKIA/ASIA、Google AIza、Slack xox[abprs]-、npm_、Stripe sk/rk_live/test + whsec_、HuggingFace hf_、SendGrid SG.、JWT eyJ、Bearer token、PEM PRIVATE KEY。
- **机制**（obfuscator.ts / message-transform.ts / placeholder.ts）：发给 provider 前把秘密替换为 keyed placeholder（HMAC，key 为 `secret-placeholder.key`，永不发给 provider，防字典反推）；工具执行前 `deobfuscateToolArguments` 还原（保证 edit 精确匹配，issue #6968）；`replace` 模式不可逆（自定义 replacement），`obfuscate` 可逆。
- pi-ai provider 边界另有无基钥流式 redaction（`[openai_token_redacted]` 等；CREDENTIAL_PREFIX_RULES 无熵门槛流式 redaction）。
- 相关：`omp cleanse` 命令做会话清洗（见 subsystems.md）。

## 8. CLI 配置管理

`omp config list|get|set|reset|path|init-xdg [--json]`（`commands/config.ts` + `cli/config-cli.ts`）；`omp setup` 初始向导；`startup.setupWizard` 控制首启向导。
