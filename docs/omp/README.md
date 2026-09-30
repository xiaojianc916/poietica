# oh-my-pi（omp）官方调研参考

> 本目录是对第三方依赖 **oh-my-pi（omp）** 的官方能力调研归档，供集成开发参考。它**不是** Poietica 自身的架构文档（自有架构见 `docs/architecture/`）。
> 来源（全部官方）：① 随 npm 发布的 `@oh-my-pi/pi-coding-agent` 18.3.0 完整 TypeScript 源码 + 9 个兄弟官方包（pi-ai / pi-catalog / pi-agent-core / pi-tui / pi-natives / pi-wire / pi-utils / snapcompact / pi-mnemopi）；② npm registry 元数据（最新 18.4.3）；③ GitHub 官方 README（can1357/oh-my-pi）；④ 官方文档站 omp.sh/docs（62 页全目录）；⑤ 官方 SDK/扩展/钩子示例（examples/）。
> 数据截止 2026-09-30；源码锚点 18.3.0（personality 与记忆章节已按 18.4.4 复核；18.4.4 中 settings 定义由 config/settings-schema.ts 迁移为 session/settings.ts 的 register 模式，键与默认值不变）。升级 18.4.x 时复核 `version-history.md` 的 Breaking Changes 与 sdk-integration.md 选项表。

## 文件索引

| 文件 | 内容 |
|---|---|
| [architecture.md](./architecture.md) | monorepo 包结构、Rust 核心、pi-natives 全导出面、平台矩阵 |
| [cli-and-modes.md](./cli-and-modes.md) | 五种运行模式、启动管线、42 个子命令、launch 全 flags、magic keywords、turn budget、/loop、环境变量、Warp/Agent Hub/status line |
| [sdk-integration.md](./sdk-integration.md) | SDK 直接集成：createAgentSession 全选项、AgentSession/SessionManager/ModelRegistry/AuthStorage/Settings 全 API、事件全型、结构化输出、MCPManager、RpcClient |
| [tools.md](./tools.md) | 工具系统：29 内置 + 隐藏 + 动态工具面逐个详解、审批三层、xd:// 设备、截断、超时 |
| [agent-core-sessions.md](./agent-core-sessions.md) | Agent 循环（steering/followUp/interrupt）、会话 JSONL 格式与 16 种 entry、树/分支、压缩五方法、snapcompact、TTSR、投机执行、系统提示词 |
| [models-providers.md](./models-providers.md) | 模型接入层：82 provider / 5510 模型、15 种传输 API、thinking 编码、caching、重试层级、usage/cost、OAuth、凭据轮换、models.yml 全格式 |
| [config-auth-secrets.md](./config-auth-secrets.md) | ~/.omp 磁盘布局、config.yml 约 480 键全表、配置层级与热重载、外来配置继承表、鉴权与 secrets |
| [extensions-skills.md](./extensions-skills.md) | 扩展 API 全成员、hooks 事件、plugins/marketplace、custom tools/commands、skills、skillshare、discovery 继承、capability 系统 |
| [code-intelligence.md](./code-intelligence.md) | LSP（54 server / 14 action）、DAP（14 adapter / 28 action）、hashline 编辑、AST、安全扫描、markit、jfind |
| [web-browser-desktop.md](./web-browser-desktop.md) | web_search（26 引擎）、90+ scraper、fetch 管线、浏览器控制、桌面控制、语音、图像、SSH、IRC、内部 URI scheme 表 |
| [memory-cognition.md](./memory-cognition.md) | 记忆：五种 backend、local 管线（SQLite 两阶段蒸馏）、mnemopi 引擎内部、sharpshooter 决策提取、hindsight、memory:// 协议、autolearn |
| [personality.md](./personality.md) | 个性化：personality 设置、三个内置人格全文、PERSONALITY.md 用户级覆盖、渲染链路与边界 |
| [subsystems.md](./subsystems.md) | 其余子系统：commit、export/share/stream/live、collab、async、task/subagent、vibe、autoresearch、eval/judgment/if-bench、cleanse、stats/telemetry、blob-broker、tiny、plan mode、daemon |
| [tui.md](./tui.md) | TUI 库：组件、overlays、主题（100 内置）、键位体系、渲染管线 |
| [security-telemetry.md](./security-telemetry.md) | 审批模型、secrets、围栏、模型输出防护、OTel 遥测、usage 统计 |
| [version-history.md](./version-history.md) | 18.x 版本演进时间线、官方文档站地图（62 页）、关键数字速查 |

## 阅读建议

- **SDK 直接集成** → 先读 `sdk-integration.md`（§3 选项表 → §5 AgentSession API → §9 官方示例），工具行为查 `tools.md`。
- **排查运行行为/配置** → `config-auth-secrets.md`（键全表）+ `agent-core-sessions.md`（压缩/重试语义）。
- **选模型/接 provider** → `models-providers.md`（含 models.yml 全格式与凭据级联）。
- 路径缩写约定（全文适用）：`CA/` = pi-coding-agent 包根、`PAC/` = pi-agent-core、`PI_AI/` = pi-ai、`PI_CAT/` = pi-catalog、`SC/` = snapcompact、`NAT/` = pi-natives、`TUI/` = pi-tui、`PU/` = pi-utils。所有源码引用均以 18.3.0 实际文件为准。

## 口径校准（避免含糊）

数字以**代码注册面**为准，官方 README 的宣传口径差异注明如下：

| 维度 | 代码事实 | README 口径 | 差异原因 |
|---|---|---|---|
| 内置工具 | 29 个 `BUILTIN_TOOL_NAMES` + 3 个 `HIDDEN_TOOL_NAMES`（yield/goal/think） | "31 built-in tools" | README 计入 tts 与 generate_image（CustomTool 形态）；browser/computer 是 eval prelude 设备不占名额 |
| 搜索引擎 | `SEARCH_PROVIDER_OPTIONS` 26 个具体引擎 + 5 个 grounded provider + auto/none | "23 providers" | 早期版本口径；含免 key 的 public/duckduckgo/startpage/ecosia/mojeek 等 |
| 进程内 coreutils | bash 内建约 46 个；pi-natives/uutils 移植 CLI 工具 58 个 | "58 ported CLI utilities" / 工具层称 "46 in-process coreutils" | 两层口径：bash 内建 coreutils ≠ 全部移植 util |
| provider 数 | 82 个 KnownProvider + 91 份 auth 契约 + 15 种传输 API；内置目录 73 provider / 5510 模型 | "60+ providers" | 18.3.0 增长后的实数 |
