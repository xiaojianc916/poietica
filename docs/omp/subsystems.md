# omp 其余子系统（task / commit / export / collab / live / async / eval / …）

> 来源：`CA/src/task/`、`commit/`、`export/`、`collab/`、`live/`、`async/`、`stats/`、`activity/`、`blob-broker/`、`exec/`、`subprocess/`、`plan-mode/`、`tiny/`、`debug/`、`vibe/`、`autoresearch/`、`eval/`、`judgment/`、`if-bench/`、`cleanse/`、omp-stats 包（18.3.0）。

## 1. Subagent / task 体系（`CA/src/task/`）

- `task` 工具 spawn 子代理（默认 agent `task`；`AgentRegistry/AgentRef/MAIN_AGENT_ID` 注册表；bundled task agents 经 `omp agents unpack` 落 `~/.omp/agent/agents` 或 `./.omp/agents`；`agents.ts` 定义）。
- 参数（4 变体：单发/批量 × isolation 开关；`task.batch` 控制批量形态）：单发 `name?`、`agent='task'`（spawn-policy 解析）、`task`（必需）、`outputSchema?`、`schemaMode permissive|strict`、`tools?`（eval-tools 开启时）、`isolated?`、`effort lo|med|hi`；批量 `context` + `tasks[]`；`"+": "delete"` 拒绝未知键；`strict=false`、`lenientArgValidation=true`（失败时产出可操作错误）。
- **隔离 worktree**：`isolated: true` → `task/worktree.ts` `ensureIsolation` 物化工作区副本——后端 `task.isolation.backend`：auto（交给 PAL）/apfs/btrfs/zfs/reflink/overlayfs/projfs/block-clone/rcopy；基线快照预算 `ISOLATION_BASELINE_MAX_CONTENT_BYTES = 1GiB`（超出抛 IsolationBaselineTooLargeError）；嵌套 git 仓库一并快照；纯 Jujutsu 仓库拒绝并提示 `jj git init --colocate`；结束由 isolation-runner 捕获变更（`task.isolation.apply` 默认 true 应用回主工作区；`merge`/`commits` 模式）并销毁；隔离会话 `workspace.additionalDirectories` 清空（executor.ts）。
- **结构化结果**：`outputSchema` + `schemaMode` → `yield` 工具按 schema 动态生成参数（`output-schema-validator.ts`：严格校验、section 化校验、strict 模式清洗；空结果重试 ≤3）；yield ladder + quiescence barrier 保证后台作业先收敛再销毁 worktree（executor.ts）。
- **并行/并发**：`task.batch`、`task/parallel.ts`、`workpool.ts`、`task.maxConcurrency`、`task.maxRecursionDepth`（默认 2）、`task.maxRuntimeMs`、`task.softRequestBudget(+Notice)`、`task.enableEffort/maxEffort`。
- **生命周期**：park/live（AgentLifecycleManager：TTL park 默认 420s + JSONL 复活）、per-agent 配置（`task.agentModelOverrides/agentServiceTierOverrides/agentPrewalk/agentAdvisor/disabledAgents[]`）、agents-hub 管理（以 LLM architect prompt 创建新 agent）、错误归因（error-attribution.ts）、label/name-generator、output-manager。
- **可观测**：`subagentEventBus` 根作用域总线 `task:subagent:*` 帧（lifecycle/progress/event 三级订阅 off|progress|events）；Agent Hub（Alt+A）总览/transcript/chat/kill/revive。
- **eval-tools**（`task/eval-tools.ts` + `eval/`）：eval 内核桥——`agent()`（spawn 子任务）、`judge()`（judge 模型批量分类）、`budget()`（turn budget 查询）、`wait()`；`eval.tools.enabled`、`eval.workpool.freshAgents`。

## 2. Eval 内核（`CA/src/eval/`）

给 agent（orchestrate/workflowz/jevify 与 subagent 场景）编程式内核：agent()/judge()/budget()/wait()；后端 py/js；`eval.autoProvision`、`eval.autoBackground.enabled+thresholdMs`；桥组件：agent-bridge、budget-bridge、completion-bridge、handle-bridge、judgment-bridge、judgment-batch-bridge(+events)、bridge-timeout、idle-timeout、executor-base、backend-helpers、input。

## 3. Autoresearch（自动实验循环，`CA/src/autoresearch/`）

- 专用系统提示（`prompt.md`，Handlebars）+ 四个受控工具：
  - `init_experiment`——开/重配会话；`new_segment: true` 开新基线段；
  - `run_experiment`——跑 `bash autoresearch.sh`（Phase 1 提交的固定基准入口）；自动捕获输出并解析 `METRIC name=value` / `ASI key=value` 行；
  - `log_experiment`——`keep`（自动提交改动）/ `discard|crash|checks_failed`（revert worktree）；`flag_runs` 标记可疑 run（排除出 baseline 与 best-metric 计算）；
  - `update_notes`——替换持久 playbook（body）或追加 ideas backlog（append_idea）；每轮注入 system prompt。
- 协议要点：先理解目标再动代码；改 `autoresearch.sh` 必须 bump segment；禁止创建 `autoresearch.md` / `.autoresearch/`；持续迭代直到用户打断或达到最大迭代。
- 状态：`~/.omp/autoresearch/`（per-project db + runs/；`OMP_AUTORESEARCH_DB_DIR`）；pi-tui dashboard app（autoresearch-dashboard）；git 集成（branch/baseline commit）；resume（command-resume.md / resume-message.md）。

## 4. Judgment（`CA/src/judgment/`）

- `judge` 模型角色的 typed judgment 解析链：native judge 候选（含 `openrouter/~typesafe/jev-latest`）、候选 TTL 重解析（`CANDIDATE_TTL_MS`——catalog 发现/角色编辑/凭据变化/会话 fallback 全生效）、bulk `judge_batch` 不逐项重扫。
- fallback 只用 native 候选（防止 prompted 模型顶替失败的 native judges，18.3.0）。
- typesafe（System One judgments）provider；judgment usage 上报含 error stop reasons 与 intent 描述（18.2.10）；TUI live 进度。

## 5. if-bench（指令跟随与工作记忆基准，`CA/src/if-bench/`）

`omp if-bench <models…>`：`--turns`（24）、`--length`（24，8–26 偶数）、`--max-tokens`（32768）、`--nya-max`（8）、`--par`（4）、`--json`；runner/protocol/actions；pi-tui if-bench-board 实时看板。

## 6. Live（`CA/src/live/`）

- live.omp.sh 双向语音会话：WebRTC（pi-voice：原生 Opus、SDP offer/answer、data-channel）；barge-in 检测（`OUTPUT_ACTIVE_LEVEL=0.015`、`MIN_BARGE_IN_LEVEL=0.04`、`OUTPUT_ECHO_RATIO=0.65`）；chunkLiveContext；`live.voice`；attestation、transport、protocol、voices、controller。

## 7. Commit（原子提交，`CA/src/commit/`）

- `omp commit`：**把工作区改动拆成依赖排序的原子提交**——pipeline（分析→分组→顺序提交）、message（conventional commits + changelog 更新：commit/changelog/）、agentic 流程（agentic/ 子目录：LLM 推理分组与验证 + agentic/tools）、`--legacy` 旧确定性管线、`--push/--dry-run/--no-changelog/-m model/-c context`。
- git 底层走 pi-natives VcsRepo（hunk 级 staging、`joinPatches`、`validateHunkSelections`）；commit-inference 缓存（`cache/commit-inference.db`，`OMP_COMMIT_CACHE_DB`）；AI 辅助 staging 验证（18.2.10 降低误报）。

## 8. Export / Share / Stream / Record（`CA/src/export/` + `CA/src/stream/`）

- **export**：`--export <file>`、`omp render`（生产 transcript 管线渲染全线程；--width/--height/--timing/--repaint/--plain）、`/export`（焦点子代理视图也可导出——18.3.0）；share.ts：`omp share <session>` 加密链接（`share.serverUrl`；`--gist` 走 secret GitHub gist）；custom-share.ts。
- **stream/record**：`/record` 录制会话为 `.ompcast`（JSONL：首行 header + `[ms, frame]`，容忍截断尾行）；`omp play`（--speed/--idle-limit）终端回放；`omp clip` 上传 live.omp.sh（--title/--description/--server）；`omp stream` 广播本地屏幕到公开 live 频道（--title 默认 cwd 名/--server/--no-tui）；协议（Unix socket/named pipe NDJSON：hello/resize/history/viewport/patch/reset/paused）；paint-encoder 行归一化 + **redactor 脱敏**（`stream.redactPatterns[]`）；多 pane 观看 TUI（console-tui）。
- TTSR 相关导出：`CA/src/export/ttsr.ts`（TTSR 管理器）。

## 9. Collab（会话协作分享，`CA/src/collab/`）

- Host 侧：tap 会话事件流与 SessionManager append chokepoint，经 relay 广播 entries/events/state 给 guest；guest 的 prompt/abort 经 host 执行；**镜像宿主子代理生态**（task EventBus 观测 HUD、agent-registry 快照、hub chat/kill/revive、增量子代理 transcript 读）。
- **加密**：AES-256-GCM 帧封装；**room key 只在链接 fragment**（relay 只见 opaque bytes）；布局 `[12B IV][ciphertext+tag]`；读写或只读链接（`--view`）。
- 入口：`/collab` 发起、`omp join` / `/join` 加入；QR；`collab.relayUrl/webUrl/displayName/autoStart`；协议类型在 pi-wire（collab.ts）；replication-shrink（增量收缩）、guest/host/registry/relay-client/controller/display-name。

## 10. Async（后台作业，`CA/src/async/`）

- AsyncJobManager：`bash async:true`、task 异步 spawn、eval autoBackground 等——job 立即返回、`wait` 收敛、auto-delivery。
- auto-background：超阈值前台命令自动转后台（`bash.autoBackground.enabled+thresholdMs+strategy`（默认 catalog））；`async.enabled/maxJobs`。
- job-control/job-manager/auto-background；快照 `getAsyncJobSnapshot({recentLimit?})`（running/recent/delivery）。

## 11. Vibe mode（`CA/src/vibe/` + `tools/vibe.ts`）

- `/vibe` 进入"导演-工人"模式：**持久可寻址 worker 会话**——每个 worker 是有完整工具权限的真 task-executor subagent（keep-alive spawn、逐 turn followUp 续跑）；turn 间作为 adopted idle agent 存活于 AgentRegistry（TTL park + JSONL 复活）；每 turn 是 AsyncJobManager job，完成自投递回导演会话；`vibe_wait` 支持 hub-wait 语义。
- 动态工具：`vibe_spawn/vibe_send/vibe_wait/vibe_kill/vibe_list`（`session.activateVibeTools/deactivateVibeTools` 装卸）。
- 状态：lifecycle/runtime/state；`VibeScreenSnapshot` 供导演观察。

## 12. 统计 / 遥测（`CA/src/stats/` + `telemetry-export*.ts` + omp-stats 包）

- `~/.omp/stats.db`（SQLite）本地用量统计；`omp stats`（HTTP dashboard :3847 默认 127.0.0.1 / --json / --summary）；activity worker（`__omp_worker_stats_activity`）与 activity-client/protocol；omp-stats sync worker（`__omp_worker_stats_sync`）。
- **OpenTelemetry**：OTLP 导出（traces/metrics/logs，proto exporter）；`OTEL_*` 全套 env；`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` 控制 GenAI 内容捕获（默认关）。
- `omp usage`：每 provider 已认证账号的用量限额（20 个内置 usage fetcher；`--history/--days/--redact/-p provider`；daybreak badge）；`/usage`、`/usage reset`；claudeResets/codexResets 自动赎回（autoRedeem、blocked 恢复、salvageHorizonHours、keepCredits；进程级共享 coordinator 防并发双花，可注入替换）。

## 13. Blob broker（`CA/src/blob-broker/`）

- 跨进程大对象传输守护（`__omp_worker_blob_broker`；`OMP_BLOB_BROKER_SOCKET/CONFIG`）。
- 组件：broker、daemon、server、protocol、context-images、destinations、exposure、publication、savings 记账；**provider-files**：Anthropic/Gemini/OpenAI 三种 provider 文件 API 直传（大图不进上下文而走 provider 侧文件托管）；provider-file-types。

## 14. 进程与执行（`CA/src/exec/` + `CA/src/subprocess/`）

- `exec/`：bash-executor（持久 shell 会话）、exec、direnv 集成（`bash.direnv` + direnvLoadTimeoutMs）、non-interactive-env（子进程环境规范化）。
- **持久代码 worker**：Python 与 Bun/JS 内核（eval 工具）能**回调 agent 工具**（ToolSession bridge）。
- `subprocess/worker-client/worker-runtime`：通用 worker 运行时（父进程失联 1s 看门狗自杀；跳过 JS/native finalizer SIGKILL）。

## 15. Plan mode（`CA/src/plan-mode/`）

- `/plan` 或 `--plan-yolo`：独立规划 turn——组件：approved-plan、model-transition（批准后按 `--plan-yolo-into`/prewalk 切快模型执行）、plan-autosave（`plan.autosave/autosaveDir`；planSaveFileName 导出）、plan-files（`local://PLAN.md`）、plan-handoff、plan-protection（plan 外写路径受限；`plan-mode-guard.ts`）、state。
- overlay：plan-review-overlay、plan-save-overlay、plan-toc；`plan.enabled/defaultOnStartup`（print 模式忽略，headless 用 `--plan-yolo`）；`setPlanProposalHandler`/`peekPlanProposalHandler`（`xd://propose` 挂接）。

## 16. Tiny（本地小模型，`CA/src/tiny/`）

- ONNX/MLX 本地推理：会话标题自动生成（title-client/title-protocol；`--no-title`/`PI_NO_TITLE` 关；replan 刷新 `title.refreshOnReplan`）、记忆辅助；`omp tiny-models download|list`；`PI_TINY_DEVICE/DTYPE/TRANSFORMERS_VERSION`；专用常驻 worker（`__omp_worker_tiny_inference`，socket `OMP_TINY_WORKER_SOCKET/_MODEL/_IDLE_MS/_TAG`——因 onnxruntime-node 在 Bun 上 finalizer 段错误 #1606 隔离到子进程）；mlx-runtime（Apple Silicon mlx-server.py）；local-inference-api（`local` provider）；completion-prompt/message-preproc/online-candidates/text/jsonl-socket/worker-server/device/dtype。

## 17. Debug 与诊断（`CA/src/debug/`）

- profiler、remote-debugger、report-bundle（`/debug` 收集环境信息包）、system-info、index。
- `grievances`（工具问题报告 auto-QA）：`dev.autoqa/autoqaPush.endpoint/token/autoqaConsent`；`~/.omp/autoqa.db`；`PI_AUTO_QA_PUSH`；`omp grievances list|clean|push`（-n limit/-t tool/-j/--id/--all）。

## 18. 其它 CLI 工具面

- `omp git`（交互式全屏 git UI，pi-tui apps/git；revision 参数如 HEAD~2）、`omp shell`（交互 shell 控制台；-C/-t/--no-snapshot）、`omp worktree/wt`（add/list/clear；-b/-B/-d/--all/-n）、`omp gc`（--apply 默认 dry-run；blobs/archive/wal/coldArchiveAfterDays 30/retainNewestGlobal 20/retainNewestPerCwd 10）、`omp bench`（chat/prefill/generation/mix 四 profile + prompt-cache 冷热对测；--runs/--max-tokens/--prompt/--par/--cache*）、`omp gallery`（工具/composer/status-line 渲染预览；--surface/--tool/--composer/--segment/--state/--width/--expanded/--plain/--screenshot VHS PNG/--font JetBrainsMono Nerd Font）、`omp setup`（onboarding 向导；components python/speech；--check/--json）、`omp update`（canary/stable 频道；--plugins 升级已装插件；GitHub 限流时 GITHUB_TOKEN/GH_TOKEN）、`omp dry-balance`（OAuth 负载均衡 dry-run）。
- `omp read`（read 工具返回预览：`:50-100`、`:raw`、URL、`omp://`、`issue://123`、zip 内路径、sqlite 表:行）、`omp find/grep/search(q)`（工具 CLI 面）、`omp models ls|find|refresh`、`omp token <provider>`（--raw/--force-refresh/--account/-l）、`omp toks`（离线 tokenizer 计数，含 Jev 编码）、`omp render`（会话全线程渲染）、`omp ttsr test|list|scan`、`omp completions <bash|zsh|fish>`。
