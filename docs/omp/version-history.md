# omp 版本演进与官方文档地图

> 来源：`CA/CHANGELOG.md`（1788 行，覆盖 18.0.8–18.3.0）、omp.sh/docs 导航（62 页）、npm registry（18.3.0 采集时）。

## 1. 版本节奏

18.x 系列约每周一个 minor、每日一个 patch；破坏性变更集中记录在各版本 Breaking Changes 节。发布经 GitHub Actions trusted publisher（npm OIDC），SLSA v1 provenance 签名。

## 2. 18.x 时间线（CHANGELOG 摘要）

- **18.0.x（2026-08 下旬）**：18.0 大版本迭代；远端压缩、fallback 体系打磨。
- **18.1.0（09-01）**：大版本功能批次；18.1.1–18.1.22（09-01～09-14）密集修复（约日更）。
- **18.2.0（09-15）**：第二个功能批次。
- **18.2.9（09-22）**：
  - Added：Claude saved resets 与 `/usage reset`（blocked 限制自动恢复 + 过期 reset 赎回，`claudeResets`）；`omp://` 文档 scope 进 find（含 file-specific 搜索与 `:start-end` selector）。
  - Changed：server-side fallback 文档与逻辑指向 claude-opus-5-5；read 图片默认内联解码、SVG 需显式 `:img`；模型发现/回退改进（认证失败在 /models hub 显现；无角色 fallback 的模型走 default 链）；MCP OAuth Google issuer 请求 offline access；omp-plugins MCP 展开 `${CLAUDE_PLUGIN_ROOT}`/`${OMP_PLUGIN_ROOT}`；粘贴/拖入图片保留原始路径；Wayland 键盘输入跟随 XKB 布局；LSP 文件创建/删除与 reload 后诊断刷新。
- **18.2.10（09-22）**：live benchmark 结果表（实时模型排名）；prefill 专用吞吐报告；**`/record`（.ompcast 录制）+ `omp play`**；judgment 批量 intent 描述与 TUI live 进度；`omp bench` 默认 profile 改 chat。
- **18.2.11（09-23）**：嵌套 eval Todo 更新修复；无根 `type` 的 JSON Schema strict 校验修复；TTSR 整缓冲匹配优化；`/shake thinking` 报告释放 token 数；browser `tab.fill` 动画帧停滞修复；LSP 首次诊断空窗修复。
- **18.3.0（09-24，本仓源码锚点）**：
  - **Breaking**：`hub` 工具弃用（改用 `wait`、`write`、`proc://` 协议）；`irc.timeoutMs` 移除；edit patch 语法改 `*** Edit File:` / `*** Find` / `*** Replace` 头（替换旧 `SM:` 头）；经 `write` 取消进程需显式 `proc://<id>/kill` 目标。
  - Added：`omp://` 文档 scope 进 find 与 `omp find`；扩展 `ctx.runEphemeralTurn()`（/btw 式侧 turn，可抑制工具与输出/上下文上限）；`wait` 工具与 `proc://` URL 的后台作业和服务管理（bash 受管服务、`agent://` write 直发 agent 消息）；`*** Insert Before/After` 编辑操作；`toks` 命令（含 Jev/TypeSafe Jev 1.13 编码）；Apple Foundation Models 自动发现（Apple silicon）；`/changelog last [N]`；终端 OAuth `omp login`（浏览器辅助、账号/组织详情、模型发现自动刷新）+ `org-scoped-identity` / `oauth-token-env` / `auth.accountPolicies`（per-account OAuth priority/reserve 策略）；`omp usage` daybreak badge；焦点子代理视图 `/export` + `/usage`；粘贴剪贴板图片存 session artifact 目录；`/annotate`（向 diff/回复/会话消息/文件/引用文本附加注释）；MCP 启动行为配置（`MCP_STARTUP_TIMEOUT_MS`/`mcp.startupTimeoutMs`、`OMP_MCP_REQUIRE_READY=1`）；native judgment usage 上报（error stop reasons）+ `openrouter/~typesafe/jev-latest` native judge 候选。
  - Changed：compaction 支持 Anthropic 快照分支与 rewind；`bash.autoBackground.strategy` 默认 `catalog`；Launch 配置组改名 Services；终端 OAuth 在 `omp login` 与 `omp auth-broker login` 间行为一致；judgment fallback 只用 native 候选；browser 截图对比容忍 rasterizer 差异。
  - Fixed：凭据感知 API key 解析（轮换期）；逗号分隔行 selector（read/grep paths/fetch）；`write` 报 UTF-8 字节数而非 JS 字符数；后台 job/服务状态（时长、job ID 复用、重启后陈旧日志）；`wait` 与 agent 消息投递（含 wait 被消息打断时）；headless print 模式慢启动 MCP server 等待与告警；reader-mode fetch 不再发内联 SVG/base64 图；judged TTSR 长 non-Latin 输出 token 感知截断。
- **18.4.3**：npm 最新（本目录调研日 2026-09-30 时点，未在本地源码内——升级时复核其 CHANGELOG）。

## 3. 官方文档地图（omp.sh/docs，62 页）

**Start**：Overview（/docs）、Quickstart、Using omp、Slash commands、Keybindings、Settings、Run modes、Sessions、Session tree、Memory、Compaction、Plan mode、Goal mode、Handoff。
**Capabilities**：Working with files、Code intelligence、Debugging、Structural edits、Code review、Creating commits、Security scans、Subagents、Advisor models、Vibe mode、Collab、Web & browser、Computer control、GitHub。
**Models**：Providers、Model roles、Agents & model roles、Custom models & providers、Prewalk。
**Customization**：Context files、Skills、Prompt templates、Magic keywords、Hooks、Custom tools、Authoring subagents、MCP、Authoring MCP servers、Themes、TTSR rules、Plugins、Authoring extensions、Marketplaces。
**Programmatic**：SDK、RPC mode、ACP。
**Reference**：CLI reference、Environment variables、Secrets and auth、Tool approvals、Session format、Tools index。

GitHub 仓库另有：docs/mcp-config.md（MCP 配置指南）、docs/mcp-runtime-lifecycle.md（MCP 运行时生命周期）、docs/mcp-server-tool-authoring.md（MCP server/tool 编写）——pi-coding-agent 包 README 引用。

## 4. 关键数字速查（全目录汇总）

| 维度 | 数字 |
|---|---|
| 运行模式 | 5（interactive TUI / print / json / rpc(+rpc-ui) / acp / SDK；协议模式 3 种） |
| 顶层子命令 | 42（含别名；隐藏 worker 选择器 13 个） |
| launch flags | 30+ 字符串值 / 1 可选值 / 20 布尔 / 2 全局 |
| Magic keywords | 4（ultrathink、orchestrate、workflowz、jevify） |
| 内置工具 | 29 builtin + 3 hidden + tts/generate_image（CustomTool 形态）+ browser/computer（prelude） |
| LSP servers / actions | 54 / 14 |
| DAP adapters / actions | 14 / 28 |
| Provider | 82 KnownProvider / 91 auth 契约 / 15 传输 API；目录 73 provider / 5510 模型 |
| 模型角色 | chat 10 + kind 5；thinking 6 档 × 5 种 wire 编码 |
| 搜索引擎 | 26 具体引擎 + 5 grounded provider |
| 专用 scrapers | 90+ 站点 handler |
| 内部 URI schemes | 16+ |
| 压缩方法 | 5（remote/snapcompact/handoff/shake/soft）+ 投机压缩 + mid-turn + idle |
| 会话 entry 类型 | 16 |
| 记忆 backend | 5（off/local/hindsight/mnemopi/sharpshooter） |
| TUI 内置主题 | 100 |
| 配置键 | ~480（settings-schema 单一事实源） |
| 环境变量 | 官方文档级 60+，源码级 100+ |
| Rust | ~80k 行 / 6 crate；6 平台 × x64 双 ISA |
| SDK 示例 | 14（examples/sdk） |
| Bun 最低 | 1.3.14；npm 最新 18.4.3（2026-09-30 调研时点） |
