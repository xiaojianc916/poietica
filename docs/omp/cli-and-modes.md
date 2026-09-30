# omp 运行模式与 CLI

> 来源：`CA/src/cli.ts`、`main.ts`、`cli-commands.ts`、`cli/*`、`modes/*`、`commands/*`、`launch/*`（18.3.0）。

## 1. 五种运行模式（`main.ts` 判定）

```
mode = --mode <text|json|rpc|rpc-ui|acp>，默认 text
pipedInput  = 协议模式 ? 无 : 读 stdin 管道
autoPrint   = 有管道输入 && 未显式 -p/--mode → 一次性 print
isInteractive = 无 -p、无 --mode、无管道输入
```

### 1.1 Interactive TUI（默认）
- 启动链：`runCli` → profile bootstrap → worker 选择器分发 → prepaint → `runInteractiveMode`（动态 import `modes/interactive-mode.ts`）。
- **Speculative first paint（prepaint）**：stdin/stdout 均 TTY 且 argv 全属 `PREPAINT_SAFE_FLAGS`（`--no-session --no-extensions --no-skills --no-rules --no-tools --no-lsp --no-title --no-prewalk --no-pty`）时先画 Composer 首帧，`ComposerLease` 接管（消除启动白屏，`modes/startup-composer.ts`）。
- 启动期：版本检查（`startup.checkUpdate`，5s 超时）、启动 changelog（`startup.changelogMode`）、setup splash（`startup.showSplash`）、`plan.defaultOnStartup` 判定。
- resume/continue/fork/foreign import：会话选择器（pi-tui `apps/session-picker`）、跨项目 resume 目录切换、目录消失移动提示（`move-directory-source.ts`）、pending tool calls 警告。
- 退出统一幂等：`session-teardown.ts`（存草稿→dispose）；Ctrl+C/Ctrl+D//exit 与 SIGINT/SIGTERM/SIGHUP/uncaughtException 同路径。
- Startup watchdog：10s 间隔挂起检测。

### 1.2 Print / one-shot（`-p`；管道输入 autoPrint；`--mode json`）
- `text`：stderr 打一次 `Working...`；stdout 只输出最终 assistant 文本（`--print-thoughts` 含 thinking，经 sanitize）；终止性失败 exit 1。
- `json`：首行 `sessionManager.getHeader()`；随后每个 `AgentSessionEvent` 一行 JSON（`printableEvent` 防体积平方膨胀：丢 `message_update` 快照与 `providerPayload`，`tool_stream_update` 只留 id/name）。
- stdout/stderr 串行化背压感知写，退出前排空。MCP：`OMP_MCP_REQUIRE_READY=1` 时未就绪硬失败。advisor 收尾 drain 10min（错误出口 30s）。plan.defaultOnStartup 在 print 模式忽略（headless 计划流用 `--plan-yolo`）。

### 1.3 RPC 模式（`--mode rpc` / `rpc-ui`）
- 传输：NDJSON over stdio；stdin 被 `claimRpcInput()` 在扩展发现前抢占；stdout 唯一协议通道（`PI_NOTIFICATIONS=off`；`RpcOutputWriter` 磁盘 spool 背压写）。
- 握手：服务端首帧 `{type:"ready", protocolVersion:1, supportedProtocolVersions:[1,2], maxFrameBytes:1048576, maxReassembledFrameBytes:67108864}`；`negotiate_protocol` 切 v2（>1MiB 帧 → 256KiB `rpc_chunk` base64 分片，重装 ≤64MiB；v1 超限走 7 级 shrink）。
- **stdin 命令全集**（`modes/rpc/rpc-types.ts`，均带可选 `id`）：协议 `negotiate_protocol`；提示 `prompt {message, images?, streamingBehavior?}`、`steer`、`follow_up`、`abort`、`abort_and_prompt`、`new_session {parentSession?}`；状态 `get_state`、`set_fast_mode`、`get_available_commands`、`get_entries {since?}`（Pi 兼容）、`get_tree`、`set_todos`、`set_host_tools`、`set_host_uri_schemes`、`set_subagent_subscription {off|progress|events}`、`get_subagents`、`get_subagent_messages`；模型 `set_model`/`cycle_model`/`get_available_models`；thinking `set_thinking_level`/`cycle_thinking_level`/`get_available_thinking_levels`；队列 `set_steering_mode all|one-at-a-time`、`set_follow_up_mode`、`set_interrupt_mode`；压缩 `compact`、`set_auto_compaction`；重试 `set_auto_retry`、`abort_retry`；bash `bash`/`abort_bash`；会话 `get_session_stats`、`export_html`、`switch_session`、`branch {entryId}`、`get_branch_messages`、`get_last_assistant_text`、`set_session_name`、`handoff`；消息 `get_messages`、`get_messages_page {cursor?, limit?}`（默认 100/上限 256/768KiB/base64url 游标；忙/陈旧游标返回结构化错误码）；登录 `get_login_providers`、`login {providerId}`。
- **stdout 帧**：`response`；AgentSessionEvent 全集；子代理帧 `subagent_lifecycle/progress/event`；扩展 UI 双向 `extension_ui_request {select|confirm|input|editor|cancel|notify|setStatus|setWidget|setTitle|set_editor_text|open_url}` ↔ `extension_ui_response`；host 帧 `host_tool_call/cancel` ↔ `host_tool_update/result`；URI 委托 `host_uri_request {read|write, url}` ↔ `host_uri_result`（宿主可注册自定义 scheme 如 `db://`）。
- 嵌入 SDK：`modes/rpc/rpc-client.ts` 导出 `RpcClient`、`RpcCommandError`、`defineRpcClientTool`。
- RPC 默认设置回填（仅未显式配置时）：HOST_DEFAULTED（task.isolation、worktree、task.batch/maxConcurrency/maxRecursionDepth、memory.backend、advisor.*、tier.advisor 等）+ RPC_BACKGROUND（async.enabled/maxJobs、bash.autoBackground、eval.autoBackground）。

### 1.4 ACP 模式（`omp acp`）
- Agent Client Protocol（Zed 等编辑器）JSON-RPC over stdio（pi-utils/acp）；`isolateProtocolStdout()` 把 fd1 专用于协议。
- Agent 侧方法：`initialize`（agentInfo {name:"oh-my-pi", title:"omp"}、authMethods `agent|terminal`、capabilities：loadSession、mcpCapabilities {http,sse}、promptCapabilities {embeddedContext,image}、sessionCapabilities {list,fork,resume,close}）、`authenticate`、`newSession`、`loadSession`、`resumeSession`、`unstable_forkSession`、`closeSession`、`setSessionConfigOption`、`prompt`（事件映射 `agent_message_chunk/agent_thought_chunk/tool_call/tool_call_update/plan/current_mode_update/config_option_update/available_commands_update/session_info_update`）。
- 扩展方法：`_omp/sessions/listAll`、`_omp/projects/list`、`_omp/chats/byCwd`、`_omp/usage`、`_omp/extensions`、`_omp/extensions/toggle`。
- UI 委托经 elicitation（select/confirm/input/editor/askDialog → 表单 schema；无 form 能力静默降级）；多会话 Map + BlobStore；`--acp-terminal-auth` 打开 TUI 供编辑器引导登录。

### 1.5 SDK 模式（进程内库）
`createAgentSession()` 直接驱动（详见 [sdk-integration.md](./sdk-integration.md)）。

## 2. 启动管线（`cli.ts`，模式共性）

1. 删 macOS malloc 调试变量 → 2. `--profile/--alias` bootstrap（`OMP_PROFILE`/`PI_PROFILE` env 同效）→ 3. worker host 声明 → 4. **13 个隐藏 worker 选择器**分发：`__omp_worker_tiny_inference`（ONNX tiny 常驻，因 onnxruntime-node 在 Bun 上 finalizer 段错误隔离到子进程）、`stats_sync`、`stats_activity`、`tab`、`computer`、`js_eval`/`js_eval_process`、`stt`、`tts`、`mnemopi_embed`、`terminal_output`、`daemon_broker`、`lsp_mux`、`blob_broker`（子进程 worker 1s 失联看门狗自杀）→ 5. `--license` → 6. prepaint → 7. `--smoke-test`（CI 全 worker 自检）→ 8. 网络引导（`PI_PROXY`）→ 9. 子命令路由 → 10. `run()`。
- 保留字拦截：`extensions/list|remove|…` 等作为裸 prompt 会被拦截报错（防泄漏给 LLM）。
- 未识别 flag：硬错误 exit 2；扩展可注册 flag 并 shadow 同名内建（reparse）。

### 2.1 daemon broker（`launch/`）
- typed ops `ping|start|list|logs|wait|send|stop|restart|mode(persist|session|detached)|describe|shutdown`，认证 socket；监督每项目单例 daemon（共享 Chromium、browser relay、LSP mux）与会话服务；presence 心跳（5min 宽限回收死 scope）；env：`OMP_DAEMON_PROJECT_DIR`、`OMP_DAEMON_RUNTIME_DIR`、`OMP_DAEMON_IDLE_GRACE_MS`。`omp ps` 是其控制面。

## 3. 顶层子命令（42 个注册项，`cli-commands.ts` + `cli/command-help.ts`）

| 命令 | 别名 | 描述 |
|---|---|---|
| `launch` | — | AI coding assistant（默认命令，隐藏；不写时 argv 全转发给它） |
| `acp` | — | ACP server（stdio） |
| `auth-broker` | — | 凭据金库（serve/token/login/logout/import/migrate/status/list） |
| `auth-gateway` | — | broker 支撑的转发代理（serve/token/status/check） |
| `agents` | — | bundled task agents 管理（unpack；--user/--project） |
| `bench` | — | 模型基准（chat/prefill/generation/mix；--runs/--max-tokens/--par/--cache* 冷热对测） |
| `browser-relay` | — | 本地 CDP relay（serve/install；--port/--token/--dir） |
| `cleanse` | — | 加权并行 subagent 修复项目诊断（默认 32 agent、@smol；-t/--tests、-a/--all） |
| `collab` | — | Collab host 元数据/控制链接（list/link；--view） |
| `commit` | — | 生成提交信息并更新 changelog（--push/--dry-run/--no-changelog/--legacy/-m/-c） |
| `completions` | — | shell 补全脚本（bash/zsh/fish；从声明式元数据实时生成） |
| `__complete` | — | （隐藏）动态补全（models/sessions） |
| `compress` | — | 文本重写进 dense prompt register（默认 3 轮、4 并发；rewrite/approve 双工具协议） |
| `config` | — | list/get/set/reset/path/init-xdg（--json） |
| `dry-balance` | — | OAuth 账号负载均衡 dry-run（--count/--concurrency/--bench） |
| `find` | — | 语义搜索（jfind） |
| `gc` | -- | 存储 GC（--apply 默认 dry-run；blobs/archive/wal/cold-archive-after-days/retain-*） |
| `git` | — | 交互式全屏 git UI（TTY） |
| `grep` | — | grep 工具测试 |
| `gallery` | — | 工具/composer/status-line 渲染预览（VHS 截图） |
| `grievances` | — | 工具问题报告（list/clean/push） |
| `images` | `img` | 图片发布后端（status/doctor/probe/purge） |
| `if-bench` | — | 指令跟随与工作记忆基准（--turns/--length/--max-tokens/--nya-max/--par） |
| `install` | — | 扩展包安装/link（--scope user|project） |
| `join` | — | 加入共享 collab 会话 |
| `login` | — | 终端 OAuth 登录 provider |
| `models` | — | 模型 ls/find/refresh（--kind/--extension） |
| `plugin` | `plugins` | 插件管理（install/uninstall/list/link/doctor/features/config/enable/disable/marketplace/discover/upgrade） |
| `ps` | — | daemon 后台进程（list/info/logs/stop/kill/restart；-a/-f/--grep/--head） |
| `say` | — | 本地 TTS 合成（--voice/--model/--file/--out） |
| `clip` | — | 上传 /record 录制到 live.omp.sh |
| `play` | — | 终端回放 .ompcast（--speed/--idle-limit） |
| `share` | — | 加密链接分享会话（--gist） |
| `setup` | — | onboarding 或可选依赖安装（python/speech） |
| `shell` | — | 交互 shell 控制台 |
| `read` | — | read 工具对路径/URL/URI 的返回预览 |
| `render` | — | 生产 transcript 管线渲染会话全线程 |
| `skill` | `skills` | Skillshare registry（publish/version/tag/yank/deprecate/owner/token/import/install/update/uninstall/search/info） |
| `ssh` | — | SSH host 管理（add/remove/list） |
| `stats` | — | 用量 dashboard（:3847/--json/--summary） |
| `stream` | — | 广播本地屏幕到公开 live 频道 |
| `update` | — | 更新检查/安装（--force/--check/--plugins/--canary/--stable） |
| `usage` | — | provider 账号用量限额（--history/--days/--redact） |
| `tiny-models` | — | tiny 本地模型下载（会话标题+记忆） |
| `token` | — | 取 provider API key/OAuth token（--raw/--force-refresh/--account） |
| `toks` | — | 离线 tokenizer 计数（含 Jev 编码） |
| `ttsr` | — | TTSR 规则测试（test/list/scan） |
| `worktree` | `wt` | worktree 管理（-b/-B/-d/--all/-n） |
| `search` | `q`, `web-search` | web 搜索 provider 测试 |

`LAUNCH_FLAG_COMMANDS = {launch, acp}` — 仅这两个接受前置 launch 全局 flag。

## 4. `omp launch` 全部 flags（`commands/launch-help.ts` + `cli/args.ts`）

### 4.1 字符串值 flags（支持 `--flag value` 与 `--flag=value`；消费下一 token 即使以 `-` 开头）

| Flag | 含义 | 默认 |
|---|---|---|
| `--cwd <dir>` | 启动目录 | 当前目录 |
| `--config <file>` | 额外 config.yml 覆盖层（可重复） | 无 |
| `--add-dir <dir>` | 追加工作区目录（multi-root，可重复） | 无 |
| `--mode <m>` | text/json/rpc/rpc-ui/acp | text |
| `--fork <src>` | 从来源分叉会话（隐藏） | 无 |
| `--provider <p>` | 旧式 provider 选择 | 无 |
| `--model <m>` | 模型（fuzzy：`opus`、`gpt-5.2`、`openai/gpt-5.2`） | settings 默认，否则首个可用 |
| `--smol/--slow/--plan <m>` | 模型角色覆盖（或 env `PI_SMOL/SLOW/PLAN_MODEL`） | 无 |
| `--prewalk-into <m>` | prewalk 目标模型 | smol 角色 |
| `--plan-yolo-into <m>` | plan-yolo 执行期目标 | smol 角色 |
| `--max-time <n>` | 会话硬截止（`5s/10m/1h`） | 无 |
| `--service-tier <v>` | OpenAI service tier | settings `tier.*` |
| `--api-key <key>` | 运行时 API key（不持久化，最高优先级） | env |
| `--system-prompt <s>` | 覆盖系统提示（与 template 互斥） | 内置 |
| `--system-prompt-template <s>` | Handlebars 模板 | 无 |
| `--append-system-prompt <s>` | 追加文本/文件（无值自动发现 `APPEND_SYSTEM.md`） | 无 |
| `--provider-session-id <id>` | provider 侧会话 id（cache + sticky auth） | 无 |
| `--prompt-cache-key <key>` | provider 侧 prompt cache key | 无 |
| `--session-dir <dir>` | 会话存储目录 | `PI_CODING_AGENT_SESSION_DIR` 或默认 |
| `--models <list>` | 模型 pattern（限定 Ctrl+P 循环） | 无 |
| `--tools <list>` | 启用工具（未知报错） | 全部 |
| `--thinking <level>` | thinking 级别 | settings |
| `--export <file>` | 导出会话 HTML 后退出 | 无 |
| `--hook <file>` / `--extension/-e <file>` | 加载 hook/extension（可重复） | 无 |
| `--trusted-extension <abs>` | 受信扩展（精确路径、禁隐式发现、禁与 -e 同用） | 无 |
| `--plugin-dir <dir>` | 附加插件目录（可重复） | 无 |
| `--skills <globs>` | glob 过滤 skills | 无 |
| `--approval-mode <m>` | always-ask/write/yolo | settings |

### 4.2 可选值 / 布尔 / 全局
- 可选值：`--resume [id]` / `-r` / `--session [id]`（bare 弹选择器；空串拒绝）。
- 布尔：`--print/-p`、`--continue/-c`、`--from-claude`、`--from-codex`、`--no-session`、`--no-tools`、`--no-lsp`、`--no-pty`、`--hide-thinking`、`--advisor`、`--external-thinking`、`--prewalk/--no-prewalk`、`--plan-yolo`、`--print-thoughts`、`--no-extensions`、`--no-skills`、`--no-rules`、`--no-title`、`--auto-approve/--yolo`、`--allow-home`、`--help/-h`、`--version/-v`。
- 全局：`--profile <name>`（隔离 auth/sessions/settings/caches）、`--alias <name>`（profile shell 快捷方式）、`--acp-terminal-auth`。
- 位置参数：prompt 文本（multiple）；`@file` 附件（引号路径支持；RPC 模式禁用报错）；`-` 视为普通消息；`--` 后全为字面 prompt；非 TTY stdin 读为 prompt（autoPrint）。

## 5. Magic keywords（`modes/magic-keywords.ts`，4 个）

匹配规则：作为**独立小写散文词**出现；效果 = 前置排队隐藏的用户归属 `<id>-notice` custom message + 编辑器渐变发光；`magicKeywords.<id>` 可开关（总开关 `magicKeywords.enabled`）。

| id | 触发词 | hue | 依赖 | notice 内容 |
|---|---|---|---|---|
| `ultrathink` | `ultrathink` | [0,330] | 无 | `<system-notice>`：多步推理，先深思再答（`prompts/system/ultrathink-notice.md`） |
| `orchestrate` | `orchestrate` | [150,280] | `task` | orchestrator 契约：分解/派发 task、最大化并行、每阶段验证、不许提前 yield、不许 scope creep 等 10 条 rules + workflow + anti-patterns |
| `workflow` | `workflowz` | [30,150] | `task`+`eval` | 按 taskBatch/scoutAvailable/evalTools 塑形的 eval workflow 提示 |
| `jevify` | `jevify` | [300,420] | `eval` | bulk classification 契约：先冻结 rubric 再看数据、eval 内核 `judge()` 批量分类、只读被 flag 的项；适用 ≥~20 同质条目 |

## 6. Turn budget 与 /loop

- **Turn budget**（`modes/turn-budget.ts`）：prompt 中独立 token `+<N>[k|m][!]`（如 `+500k`、`+2m!`）= 当轮输出 token 预算；默认 ADVISORY（模型经 eval `budget.remaining()` 自限）；`!` 变 HARD（`agent()` 达上限拒绝 spawn）。正则锚定 token 边界不误触价格/版本号。
- **/loop**（`modes/loop-limit.ts` + `loop-condition.ts`）：`/loop [count|duration] [--while|--until '<command>'] [prompt]`；裸整数=迭代次数；`10 minutes`/`1h30m` 时长；无 limit 无界。条件语义：exit 0=成功、1=条件为假、**>1=条件本身坏了**（error verdict + "Loop mode disabled"）；超时（`loop.conditionTimeoutMs` 默认 30s，0=禁用）同算 error；条件命令在独立 shell 会话（`loop-condition:<sessionId>`）防 `cd` 污染；Esc → aborted；verdict 四态 `continue|halt|error|aborted`。

## 7. 环境变量（穷尽要点）

- **provider keys**（`cli/help-extra.ts` 官方契约）：`ANTHROPIC_API_KEY`、`ANTHROPIC_OAUTH_TOKEN`（优先）、`OPENAI_API_KEY`、`GEMINI_API_KEY`、`XAI_API_KEY`、`COPILOT_GITHUB_TOKEN`、`AZURE_OPENAI_API_KEY`、`GROQ_API_KEY`、`CEREBRAS_API_KEY`、`OPENROUTER_API_KEY`、`MISTRAL_API_KEY`、`ZAI_API_KEY`、`MINIMAX_API_KEY`、`STEPFUN_API_KEY`、`AI_GATEWAY_API_KEY`、`DEEPSEEK_API_KEY`、`MOONSHOT/KIMI_*` 等。
- **云**：`AWS_PROFILE`/`AWS_ACCESS_KEY_ID`+`SECRET`、`GOOGLE_CLOUD_PROJECT/LOCATION`、`GOOGLE_APPLICATION_CREDENTIALS`、`CLAUDE_CODE_USE_FOUNDRY`、`FOUNDRY_BASE_URL`、mTLS `CLAUDE_CODE_CLIENT_CERT/KEY`、`NODE_EXTRA_CA_CERTS`。
- **搜索**：`EXA_API_KEY`、`BRAVE_API_KEY`、`PERPLEXITY_API_KEY/COOKIES`、`TAVILY_API_KEY`、`TINYFISH_API_KEY`、`FIRECRAWL_API_KEY/BASE_URL`、`SEARXNG_*`、`KAGI_API_KEY`、`MOONSHOT/KIMI_SEARCH_*`。
- **omp 自身**：`OMP_PROFILE/PI_PROFILE`、`PI_CODING_AGENT_DIR`、`PI_CONFIG_DIR`、`PI_CODING_AGENT_SESSION_DIR`、`PI_PACKAGE_DIR`、`PI_CONFIG_FILES`、`PI_PROXY`、`PI_TIMING`、`PI_COMPILED`、`PI_BUNDLED`、`PI_NO_TITLE`（由 --no-title/rpc/acp **设置**）、`PI_NO_PTY`（同）、`PI_NOTIFICATIONS`（rpc 设为 off）、`PI_SMOL/SLOW/PLAN_MODEL`、`PI_PY/PI_JS`、`PI_DISABLE_UUTILS_BUILTINS`、`PI_EDIT_VARIANT`、`PI_TASK_MAX_OUTPUT_LINES/BYTES`、`PI_DIALECT`。
- `$flag` 布尔：`PI_AUTO_QA_PUSH`、`PI_STRICT_EDIT_MODE`、`PI_PYTHON_SKIP_CHECK`、`PI_DISABLE_LSPMUX`、`OMP_MCP_REQUIRE_READY`。
- MCP：`OMP_MCP_TIMEOUT_MS`、`OMP_MCP_STARTUP_TIMEOUT_MS`（0 禁用超时）。auth-broker：`OMP_AUTH_BROKER_URL/TOKEN`。daemon/worker：`OMP_DAEMON_*`、`OMP_TINY_WORKER_*`、`OMP_LSP_MUX_*`、`OMP_BLOB_BROKER_*`。
- OTel：`OTEL_EXPORTER_OTLP_ENDPOINT/PROTOCOL/TRACES_*/METRICS_*/LOGS_*`、`OTEL_TRACES/METRICS/LOGS_EXPORTER`、`OTEL_SDK_DISABLED`、`OTEL_LOG_LEVEL`、`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`。
- Hindsight：`HINDSIGHT_API_URL/TOKEN/BANK_ID/DYNAMIC_BANK_ID/AGENT_NAME/AUTO_RECALL/AUTO_RETAIN/RETAIN_MODE/RECALL_BUDGET/RECALL_MAX_TOKENS/BANK_MISSION/DEBUG`（env 优先于设置）。
- 环境探测（只读）：`TERM/COLORTERM/TERM_PROGRAM/DISPLAY/WAYLAND_DISPLAY`、XDG 四件套、`LOCALAPPDATA/APPDATA/SYSTEMROOT`、`TERMUX_VERSION`、`VIRTUAL_ENV/CONDA_PREFIX/MISE_DATA_DIR`、`CMUX_*`、`ACTIONS_ID_TOKEN_*`、`BUN_INSTALL_GLOBAL_DIR`。
- 注意：omp **不**设置 `AGENT=1`（grep 全源码无命中；README 第三方转述有误）。

## 8. 交互层配套机制

- **Warp 终端事件桥**（`modes/warp-events.ts`）：`WARP_CLI_AGENT_PROTOCOL_VERSION>=1` 时输出 OSC `777;notify;warp://cli-agent;{JSON}`（tmux DCS passthrough；attention 事件带 BEL）。事件：session_start、prompt_submit（截断 200 codepoint）、permission_request/replied、question_asked、tool_complete、stop/stop_failure。仅 top-level interactive 注入。
- **Agent Hub**（`modes/agent-hub-runtime.ts` + pi-tui overlays/agent-hub）：AgentRegistry、AgentLifecycleManager（park/live、JSONL 复活、TTL 默认 420s）、IrcBus、活动索引、transcript 源；`agents-hub-deps.ts` 驱动 agents 管理对话框（发现、模型 pattern、LLM architect 创建新 agent）；编辑器钉住 `SubagentHudComponent`。
- **Status line**（`modes/status-line-host.ts`）：`statusLine.preset`（default/minimal/compact/full/nerd/ascii/custom）、7 种 separator、`contextLine`（off/percentage/annotated/embedded）、`sessionAccent/transparent/compactThinkingLevel/showHookStatus/segmentOptions`；服务：OAuth 身份、usage 报告、repo、`gh pr view`、tokens/sec、compaction 边界、speculation marker。
- **内置 slash 命令**（节选）：`/vibe`、`/fresh`、`/model`、`/collab`、`/review`、`/annotate`、`/login`、`/logout`、`/debug`、`/compact soft|remote|snapcompact`、`/shake`、`/clear`、`/loop`、`/record`、`/export`、`/usage`、`/join`、`/providers`、`/mcp reload`、`/reload-plugins`、`/extensions`、`/skill:<name>`、`/move`、`/wt`、`/pause`、`/btw`、`/computer`、`/guided-goal`、`/plan`、`/changelog last [N]`、`/context`、`/tree`。
- **Shell 补全**：`omp completions <bash|zsh|fish>` 从声明式元数据实时生成（永不与 CLI 表面漂移）；动态值回调 `omp __complete models|sessions`。
